import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import policy from "../renderer/data/assessment-policy.js";
import model from "../renderer/data/budget-model.js";
import freshness from "../renderer/data/inventory-freshness-status.js";
import * as evidence from "./evidence.mjs";
import { safeEnterpriseName } from "./state-store.mjs";

const capabilityReady = (value) => value?.available === true && value.authenticated === true && value.authorised === true;
const failure = (code, message) => Object.assign(new Error(message), { code, errorCode: code });
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const financialDefinition = (budget) => Object.fromEntries([
  "budget_scope", "budget_type", "budget_product_sku", "budget_entity_name",
  "entity_name", "user", "budget_amount", "exclude_cost_center_usage"
].map((field) => [field, field === "budget_amount"
  ? model.availableAmount(budget?.[field]).amount : budget?.[field] ?? null]));

export function createOperations({ session, store, readiness, clock = Date.now, readUiFacts = async () => null, inventoryPrompt }) {
  const jobs = new Map();
  const faults = new Map();
  const timestamp = () => new Date(clock()).toISOString();
  const contextFor = (input) => {
    const context = typeof input === "string" ? { enterprise: input } : input;
    safeEnterpriseName(context?.enterprise);
    const credentialMode = context.credentialMode ?? "auto";
    if (!["auto", "environment", "gh"].includes(credentialMode)) throw failure("INVALID_INPUT", "Unknown credential selection.");
    return { enterprise: context.enterprise, credentialMode, workspacePath: session.workspacePath };
  };
  const resultUrl = (enterprise) => `https://github.com/enterprises/${enterprise}/billing/budgets`;
  const apiUrl = (operation) => `https://api.github.com/enterprises/${operation.enterprise}/settings/billing/budgets`
    + (operation.target.resourceType === "budget" ? `/${operation.target.resourceId}` : "");
  const response = (operation, state) => ({
    ok: true, schemaVersion: 1, completed: operation.status === "completed",
    status: operation.status, operationId: operation.operationId, operation,
    stateRevision: state.revision, revision: state.revision, message: operation.message || "",
    audit: operation.audit || null, verification: operation.verification || null,
    actionType: operation.actionType, actionKind: operation.actionKind, rollback: operation.rollback || null,
    refreshStatus: operation.refreshStatus || "not-required", refreshMessage: operation.refreshMessage || "",
    resultUrl: resultUrl(operation.enterprise)
  });

  async function inspect(input, requirements = { actionKind: "read-only" }) {
    return readiness.inspect(contextFor(input), requirements);
  }

  async function requireReady(context, actionKind, target, actor) {
    const report = await inspect(context, { actionKind, executionPath: "api", target, ...(actor ? { actor } : {}) });
    if (report.enterprise !== context.enterprise || !report.actor || (actor && actor !== report.actor)
        || !capabilityReady(report.capabilities?.apiRead)
        || (actionKind === "write" && !capabilityReady(report.capabilities?.apiWrite))) {
      throw failure("READINESS_UNVERIFIED", "The selected actor and target do not have verified access for this operation.");
    }
    return report;
  }

  async function assertNoDispatch() {
    const active = await store.readDispatch();
    if (active) throw failure("DISPATCH_CONFLICT", "An earlier session operation remains unresolved. Reconcile it before another chat request.");
  }

  async function getState(input) {
    const context = contextFor(input);
    if (faults.has(context.enterprise)) throw faults.get(context.enterprise);
    let state = await store.read(context.enterprise);
    const active = await store.readDispatch();
    const recoverable = new Set(Object.values(state.operations)
      .filter((item) => ["prepared", "awaiting-approval", "queued", "running", "dispatching", "interrupted", "unverified"].includes(item.status))
      .map((item) => item.operationId));
    if (active?.enterprise === context.enterprise) recoverable.add(active.operationId);
    for (const id of recoverable) {
      if (jobs.has(id)) continue;
      const journal = active?.operationId === id ? active : await store.readDispatch(id);
      if (!journal || journal.enterprise !== context.enterprise) continue;
      if (journal.outcome?.operation) {
        if (!isDeepStrictEqual(state.operations[id], journal.outcome.operation)) state = await saveOperation(journal.outcome.operation);
      } else if (state.operations[id]?.status !== "interrupted") {
        state = await saveOperation({ ...journal, status: "interrupted",
          message: "Dispatch outcome is unknown after interruption. Reconcile without resending." });
      }
    }
    const snapshot = await store.readSnapshot(context.enterprise);
    return { ok: true, ...state, stateRevision: state.revision, snapshot: snapshot?.snapshot || null,
      activeDispatch: active ? { operationId: active.operationId, enterprise: active.enterprise, status: active.status } : null };
  }

  async function resolveRecommendation(context, input, state) {
    const live = await store.readSnapshot(context.enterprise);
    if (!live) throw failure("STALE_INVENTORY", "Run Inventory for this enterprise first.");
    const selection = input?.scenario || input?.selection || {};
    if (typeof selection !== "object" || Array.isArray(selection)
        || Object.keys(selection).some((key) => !["paidUsage", "budgetObjective", "costCenterName"].includes(key))) {
      throw failure("INVALID_INPUT", "Use only paidUsage, budgetObjective and costCenterName scenario fields.");
    }
    if (selection.paidUsage !== undefined && typeof selection.paidUsage !== "boolean") throw failure("INVALID_INPUT", "paidUsage must be a boolean.");
    if (selection.budgetObjective !== undefined && !["unknown", "monitor", "hard_cap"].includes(selection.budgetObjective)) {
      throw failure("INVALID_INPUT", "budgetObjective must be unknown, monitor or hard_cap.");
    }
    if (selection.costCenterName !== undefined && typeof selection.costCenterName !== "string") throw failure("INVALID_INPUT", "costCenterName must be a string.");
    const selected = {
      ...(typeof selection.paidUsage === "boolean" ? { paidUsage: selection.paidUsage } : {}),
      budgetObjective: selection.budgetObjective || "unknown",
      ...(selection.costCenterName ? { costCenterName: selection.costCenterName } : {})
    };
    const uiFacts = await readUiFacts(context);
    let scenario;
    try { scenario = policy.snapshotScenario(live.snapshot, selected, uiFacts, clock()); }
    catch { throw failure("INVALID_INPUT", "The selected cost center is not in this enterprise inventory."); }
    const assessment = policy.buildAssessment(live.snapshot, scenario);
    const action = policy.resolveAction(input?.id || input?.actionId, assessment);
    const eligible = policy.evaluateEligibility(action, {
      snapshot: live.snapshot, enterprise: context.enterprise, now: clock(), assessment, state, uiFacts
    });
    if (!eligible.allowed) throw failure(eligible.reasons[0].code, eligible.reasons.map((reason) => reason.detail).join(" "));
    return { action, snapshot: live.snapshot, selection: selected };
  }

  async function prepare(inputContext, input = {}) {
    const context = contextFor(inputContext);
    await assertNoDispatch();
    const state = await store.read(context.enterprise);
    if (input.expectedRevision !== undefined && input.expectedRevision !== state.revision) throw failure("REVISION_CONFLICT", "Reload the changed action state.");
    const { action, snapshot, selection } = await resolveRecommendation(context, input, state);
    const pending = Object.values(state.operations).find((operation) => operation.actionId === action.id
      && !["completed", "blocked", "cancelled", "needs-decision", "expired"].includes(operation.status));
    const replacePrepared = pending?.status === "prepared"
      && (pending.sourceSnapshotIdentity !== digest(snapshot) || pending.authMode !== context.credentialMode
        || !isDeepStrictEqual(pending.selection, selection));
    if (pending && !replacePrepared) return response(pending, state);
    let status = "prepared";
    let message = "";
    let budget;
    if (action.code !== "enterprise-stop-usage-disabled" || action.actionKind !== "write") {
      status = action.code === "enterprise-stop-usage-disabled"
        || ["create", "update"].includes(action.actionType) || action.code.includes("review")
        ? "needs-decision" : "blocked";
      message = "This recommendation needs a business decision or a verification method not supported by this canvas. No change was dispatched.";
    } else {
      const candidates = snapshot.budgets.filter((item) => item.budget_scope === "enterprise" && model.isAiBudget(item));
      if (candidates.length !== 1 || typeof candidates[0].id !== "string") {
        throw failure("TARGET_UNVERIFIED", "Inventory must identify one exact enterprise Copilot budget.");
      }
      budget = candidates[0];
      if (!budget.budget_type || model.availableAmount(budget.budget_amount).state !== "available") {
        throw failure("TARGET_UNVERIFIED", "The budget pricing identity and amount must be known before proposing a hard stop.");
      }
    }
    const target = { resourceType: budget ? "budget" : "budgets", enterprise: context.enterprise,
      ...(budget ? { resourceId: budget.id } : {}) };
    const report = await requireReady(context, status === "prepared" ? action.actionKind : "read-only", target);
    const observed = budget ? await readiness.readResource(context, target) : null;
    if (observed && (observed.source !== "github-api" || observed.enterprise !== context.enterprise
        || !isDeepStrictEqual(observed.target, target) || observed.data?.id !== target.resourceId
        || observed.exists !== true || observed.actor !== report.actor || observed.complete !== true
        || !isDeepStrictEqual(financialDefinition(observed.data), financialDefinition(budget))
        || observed.data?.prevent_further_usage !== false)) {
      throw failure("TARGET_CHANGED", "The current budget differs from the recommendation. Refresh Inventory.");
    }
    const operation = {
      schemaVersion: 1, operationId: randomUUID(), actionId: action.id, enterprise: context.enterprise,
      actor: report.actor, authMode: context.credentialMode, actionKind: action.actionKind, actionType: action.actionType,
      category: action.category, risk: action.risk, action: action.action, selection,
      target, requestedChange: budget ? { prevent_further_usage: true } : {},
      budgetDefinition: budget ? financialDefinition(budget) : null,
      beforeValues: budget ? { prevent_further_usage: false } : {}, postconditions: budget
        ? [{ field: "prevent_further_usage", operator: "equals", value: true }] : [],
      rollback: evidence.normalizeRollback(undefined, action.actionType, context.enterprise),
      sourceSnapshotIdentity: digest(snapshot), preparedAt: timestamp(), status, message,
      ...(status === "blocked" ? { dispatched: false } : {})
    };
    operation.planDigest = digest(operation);
    const next = await store.update(context.enterprise, state.revision, (draft) => {
      if (replacePrepared) draft.operations[pending.operationId].status = "expired";
      draft.operations[operation.operationId] = operation;
      if (status === "blocked" && action.category === "must") {
        draft.blocked[action.id] = { ...operation, validation: { beforeDispatch: true } };
      }
    });
    return response(operation, next);
  }

  async function waive(inputContext, input = {}) {
    const context = contextFor(inputContext);
    await assertNoDispatch();
    const state = await store.read(context.enterprise);
    const { action } = await resolveRecommendation(context, input, state);
    const reason = String(input.reason || "").trim();
    if (action.category !== "must" || reason.length < 10 || reason.length > 1000) {
      throw failure("INVALID_INPUT", "Waive only a current Must action with a reason of 10 to 1000 characters.");
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== state.revision) throw failure("REVISION_CONFLICT", "Reload the changed action state.");
    const waiver = { reason: evidence.redactSecrets(reason), action: action.action, risk: action.risk, updatedAt: timestamp() };
    const next = await store.update(context.enterprise, state.revision, (draft) => {
      draft.waived[action.id] = waiver;
      draft.history.push({ ...waiver, id: action.id, type: "waived", message: `Waived, not completed: ${waiver.reason}`, resultUrl: resultUrl(context.enterprise) });
    });
    return { ok: true, completed: false, status: "waived", waiver, stateRevision: next.revision };
  }

  async function saveOperation(operation) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await store.read(operation.enterprise);
      try {
        return await store.update(operation.enterprise, state.revision, (draft) => {
          draft.operations[operation.operationId] = operation;
          if (operation.status === "completed") {
            draft.completed[operation.actionId] = operation;
            delete draft.unverified[operation.actionId];
            delete draft.blocked[operation.actionId];
          } else if (["unverified", "interrupted"].includes(operation.status)) {
            draft.unverified[operation.actionId] = operation;
            delete draft.completed[operation.actionId];
          } else if (operation.validation?.beforeDispatch && operation.category === "must") {
            draft.blocked[operation.actionId] = operation;
          }
          if (["completed", "blocked", "cancelled", "unverified", "interrupted"].includes(operation.status)) {
            draft.history = draft.history.filter((item) => item.operationId !== operation.operationId);
            draft.history.push({ ...operation, id: operation.actionId, type: operation.status, resultUrl: resultUrl(operation.enterprise) });
          }
          if (operation.actionKind === "write" && operation.status === "completed") {
            draft.refresh = { status: operation.refreshStatus, actionId: operation.actionId, message: operation.refreshMessage };
          }
        });
      } catch (error) {
        if (error.code !== "REVISION_CONFLICT" || attempt === 2) throw error;
      }
    }
  }

  function launch(operation, work) {
    const job = Promise.resolve().then(work).catch(() => {
      faults.set(operation.enterprise, failure("OUTCOME_PERSISTENCE_FAILED",
        "The operation outcome could not be saved. Its dispatch journal must be reconciled; do not resend."));
    }).finally(() => jobs.delete(operation.operationId));
    jobs.set(operation.operationId, job);
  }

  async function finish(operation, outcome) {
    const final = { ...operation, ...outcome, updatedAt: timestamp() };
    await store.settleDispatch(operation.operationId, { status: final.status,
      verification: final.verification || { status: "unverified" }, operation: final });
    const state = await saveOperation(final);
    faults.delete(operation.enterprise);
    return response(final, state);
  }

  async function observe(operation, context) {
    try {
      const observation = await readiness.readResource(context, operation.target);
      const verified = evidence.verifyPostconditions(operation, observation);
      if (operation.actionKind === "write" && (!operation.budgetDefinition
          || !isDeepStrictEqual(financialDefinition(observation.data), operation.budgetDefinition))) {
        verified.status = "unverified";
        verified.reasons.push("budget-financial-definition-changed-or-unbound");
      }
      return verified;
    } catch (error) {
      return { status: "unverified", reasons: [error.code || "OBSERVATION_FAILED"], observation: null };
    }
  }

  function readAudit(operation, observation) {
    return {
      ...operation, executionPath: "api", endpointOrInterfaceUrl: apiUrl(operation),
      verificationEvidence: observation, result: "completed", timestamp: timestamp(),
      resultUrl: resultUrl(operation.enterprise)
    };
  }

  async function verifiedOutcome(operation, context, claim) {
    const verification = await observe(operation, context);
    const snapshot = await store.readSnapshot(operation.enterprise);
    const inventoryMatches = freshness.evaluateInventoryFreshness(snapshot?.snapshot, operation.enterprise, clock()).isUsable
      && Date.parse(snapshot.snapshot.generatedAt) >= Date.parse(operation.dispatchedAt)
      && (operation.actionId === "inventory"
        ? isDeepStrictEqual(snapshot.snapshot.budgets, verification.observation?.data)
        : Object.entries(operation.requestedChange).every(([field, value]) =>
          snapshot.snapshot.budgets.find((budget) => budget.id === operation.target.resourceId)?.[field] === value)
          && isDeepStrictEqual(financialDefinition(snapshot.snapshot.budgets
            .find((budget) => budget.id === operation.target.resourceId)), operation.budgetDefinition));
    if (operation.actionId === "inventory" && !inventoryMatches) {
      verification.status = "unverified";
      verification.reasons.push("snapshot-does-not-match-independent-inventory");
    }
    const audit = evidence.validateAudit(operation.actionId === "inventory"
      ? readAudit(operation, verification.observation) : claim, operation, operation.approval);
    const completed = audit.complete && verification.status === "verified";
    return {
      status: completed ? "completed" : "unverified", audit: audit.record, verification,
      message: completed ? (operation.actionId === "inventory"
        ? "The budget collection was independently verified. Other inventory sections remain agent supplied and may be incomplete."
        : "The requested outcome was independently verified.")
        : "The outcome is unverified. Reconcile the saved operation; do not repeat it.",
      refreshStatus: completed && operation.actionKind === "write" ? (inventoryMatches ? "verified" : "required") : "not-required",
      refreshMessage: completed && operation.actionKind === "write" && !inventoryMatches
        ? "Run read-only Inventory to refresh recommendations. A timestamp alone cannot satisfy this refresh." : ""
    };
  }

  async function runDispatched(operation, context) {
    try {
      const prompt = operation.actionId === "inventory"
        ? inventoryPrompt(operation.enterprise, store.inventorySnapshotPath(operation.enterprise))
        : [
            "Execute only the exact server prepared GitHub budget operation below.",
            "A native host confirmation approved this exact plan. Existing chat and tool permission controls still apply.",
            "Use the fixed GitHub API target and requested fields only. Never run rollback or repeat a mutation after an uncertain result.",
            "Stop if actor, target, supported fields or approval context differ. A blocked reply after dispatch is not proof that nothing changed.",
            `OPERATION_JSON: ${JSON.stringify(operation)}`,
            `API_TARGET: ${apiUrl(operation)}`,
            "Return AUDIT_JSON: followed by one JSON object containing schemaVersion, operationId, actionId, enterprise, actor, planDigest,",
            "actionKind, actionType, target, requestedChange, beforeValues, afterValues, executionPath, endpointOrInterfaceUrl,",
            "verificationEvidence, result, timestamp and resultUrl. verificationEvidence must identify source, enterprise, actor, target, observedAt, complete, exists and data.",
            "No prefix or prose can mark this operation complete. Never include credentials or secrets."
          ].join(" ");
      const result = await session.sendAndWait({ prompt }, 30 * 60 * 1000);
      const claim = evidence.extractResponseContent(result);
      await finish(operation, await verifiedOutcome(operation, context, claim));
    } catch (error) {
      await finish(operation, { status: "interrupted", errorCode: error.code || "OUTCOME_UNKNOWN",
        message: "Chat work may still be running. The saved operation cannot be resent or rolled back automatically.",
        verification: { status: "unverified", reasons: ["outcome-unknown"] } });
    }
  }

  async function recheck(operation, context) {
    if (operation.authMode !== context.credentialMode) throw failure("CONTEXT_MISMATCH", "Reopen this operation with its original credential selection.");
    await requireReady(context, operation.actionKind, operation.target, operation.actor);
    if (operation.actionId !== "inventory") {
      const state = await store.read(context.enterprise);
      const current = await resolveRecommendation(context, { id: operation.actionId, selection: operation.selection }, state);
      if (digest(current.snapshot) !== operation.sourceSnapshotIdentity) throw failure("PLAN_CHANGED", "Inventory changed after preparation. Prepare a new plan.");
      if (current.action.actionKind !== operation.actionKind || current.action.actionType !== operation.actionType
          || !isDeepStrictEqual(current.selection, operation.selection)) {
        throw failure("PLAN_CHANGED", "The current recommendation or explicit scenario differs from the saved plan. Prepare a new plan.");
      }
      const observation = await readiness.readResource(context, operation.target);
      if (observation.actor !== operation.actor || observation.enterprise !== operation.enterprise
          || !isDeepStrictEqual(observation.target, operation.target) || observation.complete !== true
          || observation.exists !== true || observation.data?.id !== operation.target.resourceId
          || !operation.budgetDefinition || !isDeepStrictEqual(financialDefinition(observation.data), operation.budgetDefinition)
          || Object.entries(operation.beforeValues).some(([field, value]) => observation.data[field] !== value)) {
        throw failure("TARGET_CHANGED", "The target changed or lacks a bound financial definition. Prepare a new plan before dispatch.");
      }
    }
  }

  async function proceed(inputContext, input = {}) {
    const context = contextFor(inputContext);
    const state = await store.read(context.enterprise);
    const operation = state.operations[input.operationId];
    if (!operation) throw failure("INVALID_INPUT", "Prepare a server issued operation before proceeding.");
    if (operation.status !== "prepared") return response(operation, state);
    if (input.expectedRevision !== undefined && input.expectedRevision !== state.revision) throw failure("REVISION_CONFLICT", "Reload the changed action state.");
    await assertNoDispatch();
    await recheck(operation, context);
    if (operation.actionKind === "write"
        && (session.capabilities?.ui?.elicitation !== true || typeof session.ui?.confirm !== "function")) {
      const blocked = { ...operation, status: "blocked", validation: { beforeDispatch: true },
        dispatched: false,
        message: "Native host confirmation is unavailable. No mutation was dispatched." };
      return response(blocked, await saveOperation(blocked));
    }
    const queued = { ...operation, status: operation.actionKind === "write" ? "awaiting-approval" : "queued" };
    const next = await store.update(context.enterprise, state.revision, (draft) => {
      draft.operations[operation.operationId] = queued;
    });
    launch(queued, async () => {
      let dispatched = false;
      try {
        if (queued.actionKind === "write") {
          const approved = await session.ui.confirm(
            `Approve this GitHub change?\nEnterprise: ${queued.enterprise}\nActor: ${queued.actor}\nTarget: ${queued.target.resourceId}`
            + `\nBudget amount, USD: ${queued.budgetDefinition.budget_amount}\nBudget scope: ${queued.budgetDefinition.budget_scope}`
            + `\nPricing type: ${queued.budgetDefinition.budget_type}\nProduct/SKU: ${queued.budgetDefinition.budget_product_sku}`
            + `\nScoped financial definition: ${JSON.stringify(queued.budgetDefinition)}`
            + `\nBefore: ${JSON.stringify(queued.beforeValues)}\nRequested: ${JSON.stringify(queued.requestedChange)}`
            + `\nOperation: ${queued.operationId}\nPlan: ${queued.planDigest}\nNo automatic rollback or retry.`);
          if (approved !== true) {
            await saveOperation({ ...queued, status: "cancelled", dispatched: false, message: "Native confirmation was declined. Nothing was dispatched." });
            return;
          }
          queued.approval = { source: "host-confirmation", approved: true, operationId: queued.operationId,
            planDigest: queued.planDigest, enterprise: queued.enterprise, actor: queued.actor, approvedAt: timestamp() };
        }
        await recheck(queued, context);
        queued.dispatchedAt = timestamp();
        const reservation = await store.reserveDispatch(queued);
        if (!reservation.reserved) {
          await saveOperation({ ...reservation.operation, status: "interrupted", message: "This intent was already reserved. Reconcile it without replay." });
          return;
        }
        dispatched = true;
        queued.dispatched = true;
        queued.status = "running";
        await saveOperation(queued);
        await runDispatched(queued, context);
      } catch (error) {
        const outcome = { ...queued, status: dispatched ? "interrupted" : "blocked",
          message: dispatched ? "Dispatch intent exists, but the outcome is unknown. Reconcile without replay." : evidence.redactSecrets(error.message),
          errorCode: error.code || "OPERATION_FAILED", dispatched, ...(dispatched ? {} : { validation: { beforeDispatch: true } }) };
        if (dispatched) await finish(queued, outcome);
        else await saveOperation(outcome);
      }
    });
    return response(queued, next);
  }

  async function inventory(inputContext) {
    const context = contextFor(inputContext);
    await assertNoDispatch();
    const target = { resourceType: "budgets", enterprise: context.enterprise };
    const report = await requireReady(context, "read-only", target);
    const operation = {
      schemaVersion: 1, operationId: randomUUID(), actionId: "inventory", enterprise: context.enterprise,
      actor: report.actor, authMode: context.credentialMode, actionKind: "read-only", actionType: "read-only",
      rollback: evidence.normalizeRollback(undefined, "read-only", context.enterprise),
      target, requestedChange: {}, beforeValues: {}, postconditions: [], status: "prepared", preparedAt: timestamp()
    };
    operation.planDigest = digest(operation);
    const state = await saveOperation(operation);
    return proceed(context, { operationId: operation.operationId, expectedRevision: state.revision });
  }

  async function assessment(inputContext) {
    const context = contextFor(inputContext);
    await assertNoDispatch();
    await requireReady(context, "read-only", { resourceType: "budgets", enterprise: context.enterprise });
    await session.send({ prompt: `Perform a read-only GitHub Copilot budget assessment for enterprise '${context.enterprise}'. `
      + "Refresh API inventory and official GitHub guidance first. Return Must, Should, Could and Won't recommendations in this chat. "
      + "Do not change GitHub settings. Report permission gaps, incomplete data and ambiguity. This request does not complete canvas actions." });
    return { ok: true, completed: false, status: "queued", message: "Read-only assessment requested in chat." };
  }

  async function reconcile(inputContext, input = {}) {
    const context = contextFor(inputContext);
    const state = await store.read(context.enterprise);
    const journal = await store.readDispatch(input.operationId);
    const operation = journal?.outcome?.operation || state.operations[input.operationId] || journal;
    if (!operation || operation.enterprise !== context.enterprise) throw failure("INVALID_INPUT", "No operation belongs to this enterprise and ID.");
    if (jobs.has(operation.operationId)) return response(operation, state);
    if (operation.authMode !== context.credentialMode) throw failure("CONTEXT_MISMATCH", "Use the original credential selection to reconcile.");
    await requireReady(context, "read-only", operation.target, operation.actor);
    const outcome = await verifiedOutcome(operation, context, operation.audit);
    if (journal?.outcome?.status === "completed") {
      if (outcome.status !== "completed") return { ...response(operation, state), message: "The historical outcome is verified, but current readback or refresh could not be confirmed." };
      return response({ ...operation, ...outcome }, await saveOperation({ ...operation, ...outcome }));
    }
    if (!journal) throw failure("OUTCOME_UNKNOWN", "The dispatch journal is missing. Do not infer an outcome or resend.");
    return finish(operation, outcome);
  }

  return { state: getState, inspect, prepare, proceed, reconcile, waive, inventory, assessment,
    waitForIdle: async () => { await Promise.all([...jobs.values()]); } };
}
