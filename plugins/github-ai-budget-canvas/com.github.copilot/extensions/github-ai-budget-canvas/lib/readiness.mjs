import { spawn } from "node:child_process";

const PROCESS_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 100;
const READ_TIMEOUT_MS = 60_000;
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})(?:\[bot\])?$/i;
const SLUG = /^[a-z\d]+(?:-[a-z\d]+)*$/;
const RESOURCE_ID = /^[a-z\d][a-z\d_-]{0,127}$/i;
const ORDER = [
  "GitHub REST API through gh api",
  "Authenticated GitHub UI automation",
  "Guided manual GitHub UI"
];

function failure(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.errorCode = code;
  if (statusCode) error.statusCode = statusCode;
  return error;
}

function defaultRunProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env, cwd: options.cwd, windowsHide: true, shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(failure("PROCESS_TIMEOUT", "The GitHub CLI check timed out."));
    }, options.timeout);
    const collect = (stream) => (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > options.maxBuffer) {
        child.kill();
        finish(failure("PROCESS_OUTPUT_LIMIT", "The GitHub CLI response exceeded the output limit."));
      } else if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", finish);
    child.on("close", (code) => finish(code === 0 ? null : Object.assign(
      new Error("The GitHub CLI command failed."), { stderr }
    )));
  });
}

function processFailure(error, purpose) {
  // Never expose process messages, stderr, causes or command lines, even after regex redaction.
  if (error?.code === "ENOENT") return failure("CLI_UNAVAILABLE", "GitHub CLI is not available.");
  if (error?.code === "PROCESS_TIMEOUT") return failure("PROCESS_TIMEOUT", "The GitHub CLI check timed out.");
  if (error?.code === "PROCESS_OUTPUT_LIMIT") return failure("PROCESS_OUTPUT_LIMIT", "The GitHub CLI response exceeded the output limit.");
  const statusCode = Number(`${error?.stderr || ""}\n${error?.message || ""}`.match(/\bHTTP(?:\/[\d.]+)?[ :]+(401|403|404|429|5\d\d)\b/i)?.[1]);
  if (statusCode === 401) return failure("AUTHENTICATION_FAILED", "The selected GitHub credential was not authenticated.", 401);
  if (statusCode === 403) return failure("ACCESS_DENIED", purpose === "actor"
    ? "GitHub denied /user actor lookup. GitHub App installation actors are not supported."
    : "GitHub denied the read using the selected credential.", 403);
  return failure(
    purpose === "actor" ? "ACTOR_LOOKUP_FAILED" : "PROCESS_FAILED",
    purpose === "actor"
      ? "The selected credential could not identify an actor through /user. GitHub App installation actors are not supported."
      : "The GitHub CLI read failed; no resource absence or authority was established.",
    statusCode || undefined
  );
}

function validateContext(context, requireEnterprise = true) {
  if (!context || typeof context !== "object" || Array.isArray(context)
      || (requireEnterprise && (typeof context.enterprise !== "string"
        || context.enterprise.length > 100 || !SLUG.test(context.enterprise)))
      || (context.workspacePath !== undefined && (typeof context.workspacePath !== "string" || !context.workspacePath.trim()))) {
    throw failure("INVALID_CONTEXT", "A valid enterprise slug and credential context are required.");
  }
  const credentialMode = context.credentialMode ?? "auto";
  if (!["auto", "environment", "gh"].includes(credentialMode)) {
    throw failure("INVALID_CREDENTIAL_MODE", "Credential mode must be auto, environment or gh.");
  }
  return Object.freeze({ enterprise: context.enterprise, credentialMode, workspacePath: context.workspacePath });
}

const capability = (reason, available = null, authenticated = null, authorised = null) =>
  ({ available, authenticated, authorised, reason });

function validateTarget(context, target) {
  if (!target || typeof target !== "object" || Array.isArray(target)
      || Object.keys(target).some((key) => !["resourceType", "enterprise", "resourceId"].includes(key))
      || !["budget", "budgets"].includes(target.resourceType)
      || (target.enterprise !== undefined && target.enterprise !== context.enterprise)
      || (target.resourceType === "budget" && (typeof target.resourceId !== "string" || !RESOURCE_ID.test(target.resourceId)))
      || (target.resourceType === "budgets" && target.resourceId !== undefined)) {
    throw failure("UNSUPPORTED_TARGET", "Only budget or budgets targets within the selected enterprise are supported.");
  }
  return Object.freeze({
    resourceType: target.resourceType, enterprise: context.enterprise,
    ...(target.resourceType === "budget" ? { resourceId: target.resourceId } : {})
  });
}

function validateRequirements(context, requirements) {
  if (!requirements || typeof requirements !== "object" || Array.isArray(requirements)) {
    throw failure("INVALID_REQUIREMENTS", "Readiness requirements must describe the selected operation.");
  }
  const actionKind = requirements.actionKind ?? "read-only";
  const executionPath = requirements.executionPath ?? (requirements.driver ? "ui" : "api");
  if (!["read-only", "write"].includes(actionKind) || !["api", "ui", "manual"].includes(executionPath)
      || (requirements.actor !== undefined && (typeof requirements.actor !== "string" || !LOGIN.test(requirements.actor)))
      || (requirements.driver !== undefined && (executionPath !== "ui" || !["playwright", "windows-uia"].includes(requirements.driver)))) {
    throw failure("INVALID_REQUIREMENTS", "The operation kind, execution path, driver or expected actor is unsupported.");
  }
  return Object.freeze({
    actionKind, executionPath, driver: requirements.driver, actor: requirements.actor,
    target: validateTarget(context, requirements.target ?? { resourceType: "budgets" })
  });
}

/**
 * env is captured once, preserving granted tokens across preflight and readback.
 * An explicit gh selection conflicts with environment tokens rather than removing them.
 */
export function createReadiness({ runProcess = defaultRunProcess, env = process.env, clock = Date.now, driverProbe } = {}) {
  const grantedEnv = Object.freeze({ ...env });
  const tokens = ["GH_TOKEN", "GITHUB_TOKEN"].map((key) => grantedEnv[key]).filter((value) => typeof value === "string" && value.length);
  const containsToken = (value) => tokens.some((token) => value.includes(token));
  const timestamp = () => new Date(clock()).toISOString();

  function selectCredential(context) {
    const source = ["GH_TOKEN", "GITHUB_TOKEN"].find((key) => typeof grantedEnv[key] === "string" && grantedEnv[key].length);
    if (context.credentialMode === "environment" && !source) {
      throw failure("CREDENTIAL_UNAVAILABLE", "Environment authentication was selected but no token was granted.");
    }
    if (context.credentialMode === "gh" && source) {
      throw failure("CREDENTIAL_CONTEXT_CONFLICT", "Stored GitHub CLI credentials were selected, but a granted environment token would override them.");
    }
    return {
      source: source || "gh",
      env: Object.freeze({
        ...grantedEnv,
        GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_DEBUG: "", DEBUG: "",
        GH_PAGER: "", PAGER: "", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1"
      })
    };
  }

  async function execute(context, credential, args, purpose) {
    try {
      const result = await runProcess("gh", args, {
        env: credential.env, cwd: context.workspacePath, shell: false,
        windowsHide: true, timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES
      });
      if (typeof result?.stdout !== "string") throw new Error("Invalid process response");
      if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr || "") > MAX_OUTPUT_BYTES) {
        throw failure("PROCESS_OUTPUT_LIMIT", "Output limit");
      }
      if (containsToken(result.stdout)) throw new Error("Unexpected credential in output");
      return result.stdout;
    } catch (error) {
      throw processFailure(error, purpose);
    }
  }

  const apiArgs = (route) => [
    "api", "--hostname", "github.com", "--method", "GET", route,
    "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10"
  ];

  async function lookupActor(context, credential, expectedActor) {
    const raw = await execute(context, credential, apiArgs("user"), "actor");
    let actor;
    try { actor = JSON.parse(raw)?.login; } catch { /* Invalid data is handled below. */ }
    if (typeof actor !== "string" || !LOGIN.test(actor) || containsToken(actor)) {
      throw failure("ACTOR_LOOKUP_FAILED", "GitHub did not return a supported actor identity.");
    }
    if (expectedActor !== undefined && actor.toLowerCase() !== expectedActor.toLowerCase()) {
      throw Object.assign(failure("ACTOR_CONTEXT_MISMATCH", "The authenticated GitHub actor differs from the required actor."), { actor });
    }
    return actor;
  }

  async function getAuthenticatedAccount(context = { credentialMode: "auto" }) {
    const selected = validateContext(context, false);
    return lookupActor(selected, selectCredential(selected));
  }

  async function readBudgets(context, credential) {
    // This endpoint uses body pagination, not necessarily Link headers:
    // https://docs.github.com/en/enterprise-cloud@latest/rest/billing/budgets#get-all-budgets
    const budgets = [];
    const seen = new Set();
    const startedAt = clock();
    let totalCount;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (clock() - startedAt >= READ_TIMEOUT_MS) {
        throw failure("PAGINATION_TIMEOUT", "Budget collection retrieval exceeded its time limit.");
      }
      const raw = await execute(context, credential, apiArgs(
        `enterprises/${context.enterprise}/settings/billing/budgets?per_page=100&page=${page}`
      ), "resource");
      let body;
      try { body = JSON.parse(raw); } catch { /* Reject malformed data below. */ }
      if (!body || !Array.isArray(body.budgets) || body.budgets.length > 100 || containsToken(JSON.stringify(body))) {
        throw failure("INVALID_API_RESPONSE", "GitHub did not return a valid budget collection.");
      }
      if ((body.has_next_page !== undefined && typeof body.has_next_page !== "boolean")
          || (body.total_count !== undefined && (!Number.isSafeInteger(body.total_count) || body.total_count < 0))) {
        throw failure("PAGINATION_INCOMPLETE", "Budget pagination metadata is invalid.");
      }
      if (body.total_count !== undefined) {
        if (totalCount !== undefined && totalCount !== body.total_count) {
          throw failure("PAGINATION_INCOMPLETE", "The budget collection changed during pagination.");
        }
        totalCount = body.total_count;
      }
      for (const budget of body.budgets) {
        if (!budget || typeof budget.id !== "string" || !RESOURCE_ID.test(budget.id)) {
          throw failure("INVALID_API_RESPONSE", "A budget has no supported exact identity.");
        }
        if (seen.has(budget.id)) {
          throw failure("PAGINATION_INCOMPLETE", "Budget identities were repeated during pagination.");
        }
        seen.add(budget.id);
        budgets.push(budget);
      }
      const next = body.has_next_page ?? (totalCount === undefined ? null : budgets.length < totalCount);
      if (next === null || (next && body.budgets.length === 0)
          || (totalCount !== undefined && (budgets.length > totalCount
            || (!next && budgets.length !== totalCount) || (next && budgets.length >= totalCount)))) {
        throw failure("PAGINATION_INCOMPLETE", "Complete budget collection retrieval could not be established.");
      }
      if (!next) return budgets;
    }
    throw failure("PAGINATION_LIMIT", "Budget collection retrieval exceeded the page limit.");
  }

  /**
   * Complete means every page of the credential-visible collection was read.
   * An individual budget is selected by exact id, never a name or a supplied route.
   * Errors, including a 404 or partial collection, never become exists:false.
   * The documented collection may hide budgets outside the caller's permissions.
   * Without a full-visibility proof, even a paginated no-match cannot prove deletion.
   */
  async function readResource(context, target) {
    const selected = validateContext(context);
    const resource = validateTarget(selected, target);
    const credential = selectCredential(selected);
    const actor = await lookupActor(selected, credential);
    const budgets = await readBudgets(selected, credential);
    await lookupActor(selected, credential, actor);
    const data = resource.resourceType === "budgets" ? budgets : budgets.find((budget) => budget.id === resource.resourceId) ?? null;
    if (data === null) {
      throw failure("RESOURCE_ABSENCE_UNPROVEN", "The complete visible collection did not include this budget. Permission filtering prevents proving its absence.");
    }
    return {
      source: "github-api", enterprise: selected.enterprise, actor, target: resource,
      observedAt: timestamp(), complete: true, exists: true, data
    };
  }

  async function inspectDriver(context, requirements) {
    const unknown = capability("No authenticated automation driver has been proven.");
    if (requirements.executionPath === "manual") {
      return { actor: null, value: { ...unknown, reason: "Guided manual UI is not an automated or verified execution path." }, errorCode: "MANUAL_VERIFICATION_REQUIRED" };
    }
    if (!requirements.driver || typeof driverProbe !== "function") {
      return { actor: null, value: unknown, errorCode: "DRIVER_UNPROVEN" };
    }
    let timer;
    let probe;
    try {
      probe = await Promise.race([
        Promise.resolve().then(() => driverProbe(context, requirements)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Probe timeout")), PROCESS_TIMEOUT_MS); })
      ]);
    } catch {
      return { actor: null, value: capability("The selected UI driver probe failed; no session authority was established."), errorCode: "DRIVER_PROBE_FAILED" };
    } finally {
      clearTimeout(timer);
    }
    if (!probe || probe.driver !== requirements.driver
        || ["available", "controllable", "authenticated", "authorised"].some((key) =>
          probe[key] !== undefined && probe[key] !== null && typeof probe[key] !== "boolean")) {
      return { actor: null, value: capability("The probe did not identify the selected UI driver."), errorCode: "DRIVER_PROBE_INVALID" };
    }
    const value = capability("The selected driver has not proven a controllable session.", probe.available ?? null);
    if (value.available !== true || probe.controllable !== true) {
      return { actor: null, value, errorCode: "DRIVER_SESSION_UNPROVEN" };
    }
    value.authenticated = probe.authenticated ?? null;
    if (value.authenticated !== true) {
      value.reason = "The selected driver has not proven an authenticated GitHub session.";
      return { actor: null, value, errorCode: "DRIVER_AUTHENTICATION_UNPROVEN" };
    }
    if (typeof probe.actor !== "string" || !LOGIN.test(probe.actor) || containsToken(probe.actor)) {
      value.authenticated = null;
      value.reason = "The selected driver did not identify a supported GitHub actor.";
      return { actor: null, value, errorCode: "DRIVER_ACTOR_UNKNOWN" };
    }
    const actor = probe.actor;
    if (probe.enterprise !== context.enterprise || (requirements.actor !== undefined && actor.toLowerCase() !== requirements.actor.toLowerCase())) {
      value.authorised = false;
      value.reason = "The UI session actor or enterprise differs from the selected context.";
      return { actor, value, errorCode: "DRIVER_CONTEXT_MISMATCH" };
    }
    let target;
    try { target = validateTarget(context, probe.target); } catch { /* Missing target evidence stays unknown. */ }
    if (probe.actionKind !== requirements.actionKind || !target
        || target.resourceType !== requirements.target.resourceType || target.resourceId !== requirements.target.resourceId) {
      value.reason = "The selected driver has not proven authority for this operation and exact target.";
      return { actor, value, errorCode: "DRIVER_AUTHORISATION_UNPROVEN" };
    }
    value.authorised = probe.authorised ?? null;
    value.reason = value.authorised === true
      ? "The selected driver reports a controllable, authenticated session with access to the requested operation and target."
      : "The selected driver has not established permission for the requested operation and target.";
    return { actor, value, ...(value.authorised === true ? {} : { errorCode: "DRIVER_AUTHORISATION_UNPROVEN" }) };
  }

  /**
   * requirements: actionKind, executionPath (api/ui/manual), optional driver
   * (playwright/windows-uia), actor (expected login), and target (defaults to budgets).
   * Only the selected path is probed. driverProbe(context, requirements) is a trusted,
   * read only adapter returning driver, available, controllable, authenticated,
   * authorised, actor, enterprise, actionKind and target. Mere installed tools,
   * caller readiness flags and OAuth scope strings are never authority.
   */
  async function inspect(context, requirements = { actionKind: "read-only" }) {
    const selected = validateContext(context);
    const required = validateRequirements(selected, requirements);
    const credential = selectCredential(selected);
    const capabilities = {
      apiRead: capability("API read access has not been checked."),
      apiWrite: capability("Write authority is unproven; scope strings cannot establish target permission."),
      ui: capability("No authenticated automation driver has been proven.")
    };
    const checks = [];
    let actor = null;
    let credentialSource = credential.source;
    const result = () => ({
      checkedAt: timestamp(), enterprise: selected.enterprise, actor, credentialSource,
      capabilities, checks, order: [...ORDER]
    });
    const add = (name, status, detail, errorCode) => checks.push({
      name, status, detail, required: true, ...(errorCode ? { errorCode } : {})
    });
    if (required.executionPath !== "api") {
      const ui = await inspectDriver(selected, required);
      actor = ui.actor;
      credentialSource = required.executionPath === "ui" ? "browser-session" : "manual";
      capabilities.ui = { ...ui.value, driver: required.driver ?? null };
      add("UI automation fallback", ui.value.available === true && ui.value.authenticated === true && ui.value.authorised === true
        ? "ready" : "blocked", ui.value.reason, ui.errorCode);
      return result();
    }
    let stage = "availability";
    try {
      await execute(selected, credential, ["--version"], "availability");
      add("GitHub CLI", "ready", "GitHub CLI is available.");
      capabilities.apiRead.available = capabilities.apiWrite.available = true;
      stage = "actor";
      actor = await lookupActor(selected, credential, required.actor);
      capabilities.apiRead.authenticated = capabilities.apiWrite.authenticated = true;
      add("Active GitHub account", "ready", actor);
      stage = "resource";
      const budgets = await readBudgets(selected, credential);
      await lookupActor(selected, credential, actor);
      const targetVisible = required.target.resourceType === "budgets"
        || budgets.some((budget) => budget.id === required.target.resourceId);
      capabilities.apiRead.authorised = targetVisible ? true : null;
      capabilities.apiRead.reason = targetVisible
        ? "The selected actor read every page of the visible budget collection for the requested target."
        : "The requested budget was not visible; its individual access has not been proven.";
      add("Enterprise billing read access", targetVisible ? "ready" : "blocked",
        capabilities.apiRead.reason, targetVisible ? undefined : "TARGET_NOT_OBSERVED");
    } catch (error) {
      if (error.code === "CLI_UNAVAILABLE") capabilities.apiRead.available = capabilities.apiWrite.available = false;
      if (error.code === "AUTHENTICATION_FAILED") capabilities.apiRead.authenticated = capabilities.apiWrite.authenticated = false;
      if (error.code === "ACCESS_DENIED" && stage === "resource") capabilities.apiRead.authorised = false;
      if (error.code === "ACTOR_CONTEXT_MISMATCH") {
        actor = error.actor;
        capabilities.apiRead.authenticated = capabilities.apiWrite.authenticated = true;
        capabilities.apiRead.authorised = capabilities.apiWrite.authorised = false;
      }
      capabilities.apiRead.reason = error.message;
      add(stage === "availability" ? "GitHub CLI" : stage === "actor" ? "Active GitHub account" : "Enterprise billing read access",
        "blocked", error.message, error.code);
    }
    if (required.actionKind === "write") {
      add("Current API write credential", "blocked", capabilities.apiWrite.reason, "WRITE_AUTHORITY_UNPROVEN");
    }
    return result();
  }

  async function checkPrerequisites(enterprise) {
    return inspect({ enterprise, credentialMode: "auto" });
  }

  return { inspect, readResource, getAuthenticatedAccount, checkPrerequisites };
}
