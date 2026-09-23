import * as filesystem from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { redactSecrets, incompleteLegacyAudit, normalizeLegacyRecord } from "./evidence.mjs";

const maps = ["operations", "unverified", "completed", "blocked", "waived"];
const deniedCodes = new Set(["EACCES", "EPERM", "EROFS"]);
const retryCodes = new Set(["EBUSY", "EAGAIN", "EINTR", "EMFILE", "ENFILE", "ETXTBSY"]);
const intentFields = [
  "schemaVersion", "operationId", "actionId", "enterprise", "actor", "actionKind",
  "actionType", "target", "requestedChange", "beforeValues", "postconditions", "planDigest"
];
const outcomeStatuses = new Set(["completed", "cancelled", "blocked", "failed", "interrupted", "unverified", "unsupported"]);

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, errorCode: code, ...details });
}

function filesystemFailure(error, code, message) {
  return failure(deniedCodes.has(error?.code) ? "FILESYSTEM_DENIED" : code, message, {
    filesystemCode: typeof error?.code === "string" ? error.code : "UNKNOWN"
  });
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function jsonData(value, code, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if ((!object(value) && !Array.isArray(value)) || seen.has(value)) {
    throw failure(code, "Durable records must contain only finite, acyclic JSON values.");
  }
  seen.add(value);
  for (const item of Object.values(value)) jsonData(item, code, seen);
  seen.delete(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordMap(value) {
  return object(value) && Object.values(value).every(object);
}

function revision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function identifier(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value)
    && !["constructor", "prototype", "__proto__"].includes(value);
}

function timestamp(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function intentDigest(operation) {
  const intent = Object.fromEntries(intentFields.map((key) => [key, operation[key]]));
  return createHash("sha256").update(canonical(intent)).digest("hex");
}

export function safeEnterpriseName(enterprise) {
  // Reject aliases rather than rewriting them into colliding Windows filenames.
  if (typeof enterprise !== "string" || enterprise.length > 100
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(enterprise)) {
    throw failure("INVALID_ENTERPRISE", "Use a canonical lowercase enterprise slug, not a URL or path.");
  }
  return enterprise;
}

function emptyState(enterprise) {
  return {
    schemaVersion: 2, enterprise, revision: 0,
    operations: {}, unverified: {}, completed: {}, blocked: {}, waived: {}, history: [], refresh: null
  };
}

function legacyRecords(value, fallback, enterprise, result) {
  if (value === undefined) return {};
  if (!object(value) || Object.values(value).some((item) => !object(item) && typeof item !== "string")) {
    throw failure("STATE_CORRUPT", "Legacy action records have an invalid shape.");
  }
  return Object.fromEntries(Object.entries(value).map(([id, value]) => {
    const item = { ...fallback, ...normalizeLegacyRecord(value, fallback) };
    if (result === "waived" && typeof value === "string") item.reason = value;
    if (!item.audit) item.audit = incompleteLegacyAudit(enterprise, id, result, item.updatedAt, item.resultUrl);
    return [id, item];
  }));
}

function migrateLegacy(state, enterprise) {
  if (!["completed", "blocked", "waived", "history", "refresh", "unverified", "operations"].some((key) => Object.hasOwn(state, key))) {
    throw failure("STATE_CORRUPT", "The state file contains no recognised action state.");
  }
  if (state.revision !== undefined && !revision(state.revision)) {
    throw failure("STATE_CORRUPT", "The legacy state revision is invalid.");
  }
  const next = { ...emptyState(enterprise), revision: state.revision ?? 0 };
  let completed = state.completed;
  if (Array.isArray(completed)) {
    if (!completed.every((id) => typeof id === "string" && id.length > 0)) {
      throw failure("STATE_CORRUPT", "Legacy completion IDs must be nonempty strings.");
    }
    completed = Object.fromEntries(completed.map((id) => [id, {}]));
  }
  next.unverified = legacyRecords(state.unverified, {}, enterprise, "unverified");
  const claims = legacyRecords(completed, {
    action: "Completed action",
    message: "Completed in this Copilot session.",
    resultUrl: `https://github.com/enterprises/${enterprise}/billing/budgets`,
    updatedAt: ""
  }, enterprise, "completed");
  for (const [id, item] of Object.entries(claims)) {
    // Legacy "complete" flags predate server approval and independent readback.
    next.unverified[id] = {
      ...item,
      ...(Object.hasOwn(next.unverified, id) ? { ...next.unverified[id], legacyCompletion: item } : {}),
      status: "unverified",
      migrationReason: "legacy-completion-unverified"
    };
  }
  next.blocked = legacyRecords(state.blocked, { message: "Blocked action", updatedAt: "", resultUrl: "" }, enterprise, "blocked");
  next.waived = legacyRecords(state.waived, { reason: "Legacy waiver", updatedAt: "" }, enterprise, "waived");
  if (state.operations !== undefined) next.operations = state.operations;
  if (state.history !== undefined && (!Array.isArray(state.history) || !state.history.every(object))) {
    throw failure("STATE_CORRUPT", "Legacy history must be an array of records.");
  }
  next.history = (state.history || []).map((entry) => ({
    ...entry,
    audit: entry.audit || incompleteLegacyAudit(enterprise, entry.id || "", entry.type || "unknown", entry.updatedAt, entry.resultUrl)
  }));
  next.refresh = state.refresh === undefined ? null : state.refresh;
  return next;
}

function decodeState(value, enterprise) {
  jsonData(value, "STATE_CORRUPT");
  if (!object(value)) throw failure("STATE_CORRUPT", "The state file must contain an object.");
  if (value.schemaVersion !== undefined && ![1, 2].includes(value.schemaVersion)) {
    throw failure("STATE_SCHEMA_UNSUPPORTED", "The action state schema is unsupported.");
  }
  if (value.enterprise !== undefined && value.enterprise !== enterprise) {
    throw failure("STATE_ENTERPRISE_MISMATCH", "The action state belongs to a different enterprise.");
  }
  const state = value.schemaVersion === 2 ? value : migrateLegacy(value, enterprise);
  if (state.enterprise !== enterprise) {
    throw failure("STATE_ENTERPRISE_MISMATCH", "The action state does not identify the active enterprise.");
  }
  if (!revision(state.revision) || !maps.every((key) => recordMap(state[key]))
      || !Array.isArray(state.history) || !state.history.every(object)
      || (state.refresh !== null && !object(state.refresh))) {
    throw failure("STATE_CORRUPT", "The action state has an invalid version 2 shape.");
  }
  for (const [id, operation] of Object.entries(state.operations)) {
    if (operation.operationId !== id || operation.enterprise !== enterprise) {
      throw failure("STATE_CORRUPT", "A stored operation does not match its state identity.");
    }
  }
  return clone(state);
}

function normalizeOperation(value) {
  jsonData(value, "INVALID_OPERATION");
  if (!object(value) || value.schemaVersion !== 1 || !identifier(value.operationId)
      || typeof value.actionId !== "string" || !value.actionId.trim()
      || typeof value.actor !== "string" || !value.actor.trim()
      || !["write", "read-only"].includes(value.actionKind)
      || !["create", "update", "delete", "read-only"].includes(value.actionType)
      || (value.actionKind === "read-only") !== (value.actionType === "read-only")
      || !object(value.target) || value.target.enterprise !== value.enterprise
      || typeof value.target.resourceType !== "string" || !value.target.resourceType
      || !Object.hasOwn(value, "requestedChange") || !Object.hasOwn(value, "beforeValues")
      || !Array.isArray(value.postconditions) || !value.postconditions.every(object)
      || typeof value.planDigest !== "string" || !value.planDigest.trim()) {
    throw failure("INVALID_OPERATION", "A dispatch requires a complete server issued operation and matching target.");
  }
  try {
    safeEnterpriseName(value.enterprise);
  } catch {
    throw failure("INVALID_OPERATION", "The dispatch enterprise must be a canonical slug.");
  }
  if (value.actionKind === "write" && (!object(value.requestedChange) || !object(value.beforeValues)
      || value.postconditions.length === 0
      || (["update", "delete"].includes(value.actionType)
        && (typeof value.target.resourceId !== "string" || !value.target.resourceId)))) {
    throw failure("INVALID_OPERATION", "Mutation intent requires typed values, postconditions and an exact target.");
  }
  const operation = clone(redactSecrets(value));
  if (intentDigest(operation) !== intentDigest(value)) {
    throw failure("INVALID_OPERATION", "Dispatch identity must not contain secret values.");
  }
  return operation;
}

function normalizeOutcome(value) {
  jsonData(value, "INVALID_OUTCOME");
  if (!object(value) || !outcomeStatuses.has(value.status)
      || (value.dispatched !== undefined && typeof value.dispatched !== "boolean")
      || (value.verification !== undefined && !object(value.verification))) {
    throw failure("INVALID_OUTCOME", "A dispatch outcome requires a supported status and structured evidence.");
  }
  return clone(redactSecrets(value));
}

function terminalOutcome(outcome) {
  return outcome?.status === "completed" && outcome.verification?.status === "verified"
    || ["cancelled", "blocked", "failed"].includes(outcome?.status) && outcome.dispatched === false;
}

function emptyJournal() {
  return { schemaVersion: 1, revision: 0, activeOperationId: null, operations: {} };
}

function decodeJournal(value) {
  jsonData(value, "JOURNAL_CORRUPT");
  if (!object(value)) throw failure("JOURNAL_CORRUPT", "The dispatch journal must contain an object.");
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    throw failure("JOURNAL_SCHEMA_UNSUPPORTED", "The dispatch journal schema is unsupported.");
  }
  if (value.schemaVersion !== 1 || !revision(value.revision) || !recordMap(value.operations)
      || (value.activeOperationId !== null && !identifier(value.activeOperationId))) {
    throw failure("JOURNAL_CORRUPT", "The dispatch journal has an invalid shape.");
  }
  const unresolved = [];
  for (const [id, entry] of Object.entries(value.operations)) {
    try {
      normalizeOperation(entry.operation);
      if (entry.outcome !== null) normalizeOutcome(entry.outcome);
    } catch {
      throw failure("JOURNAL_CORRUPT", "The dispatch journal contains an invalid operation or outcome.");
    }
    if (entry.operation.operationId !== id || !timestamp(entry.reservedAt)
        || (entry.settledAt !== null && !timestamp(entry.settledAt))
        || entry.intentDigest !== intentDigest(entry.operation)
        || typeof entry.terminal !== "boolean" || entry.terminal !== terminalOutcome(entry.outcome)) {
      throw failure("JOURNAL_CORRUPT", "The dispatch journal contains contradictory operation evidence.");
    }
    if (!entry.terminal) unresolved.push(id);
  }
  if (unresolved.length > 1 || (unresolved[0] ?? null) !== value.activeOperationId) {
    throw failure("JOURNAL_CORRUPT", "The dispatch barrier does not match the unresolved operation.");
  }
  return value;
}

function dispatchResult(entry) {
  const status = entry.terminal ? entry.outcome.status
    : entry.outcome === null ? "dispatching"
      : entry.outcome.status === "interrupted" ? "interrupted" : "unverified";
  return clone({
    ...entry.operation,
    status,
    reservedAt: entry.reservedAt,
    settledAt: entry.settledAt,
    outcome: entry.outcome
  });
}

/**
 * fs is a node:fs/promises compatible adapter; clock returns epoch milliseconds.
 * update's synchronous callback may mutate its draft or return replacement state.
 * The journal is the session dispatch authority, independent of state projections.
 */
export function createStateStore({ workspacePath, fs = filesystem, clock = Date.now, platform = process.platform } = {}) {
  if (typeof workspacePath !== "string" || !workspacePath.trim() || !isAbsolute(workspacePath)) {
    throw failure("WORKSPACE_REQUIRED", "An absolute writable session workspace is required for durable state.");
  }
  const workspace = resolve(workspacePath);
  const journalPath = join(workspace, "github-ai-budget-dispatch.json");
  const replacementRetryCodes = new Set([...retryCodes, ...(platform === "win32" ? ["EACCES", "EPERM"] : [])]);

  function now() {
    const value = clock();
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 8.64e15) {
      throw failure("INVALID_CLOCK", "The state clock must return valid epoch milliseconds.");
    }
    return new Date(value).toISOString();
  }

  function inventorySnapshotPath(enterprise) {
    return join(workspace, `github-ai-budget-snapshot-${safeEnterpriseName(enterprise)}.js`);
  }

  function actionStatePath(enterprise) {
    return join(workspace, `github-ai-budget-actions-${safeEnterpriseName(enterprise)}.json`);
  }

  async function readText(path, kind) {
    try {
      return await fs.readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw filesystemFailure(error, `${kind}_READ_FAILED`, `Cannot read durable ${kind.toLowerCase()} data.`);
    }
  }

  function parse(source, kind) {
    try {
      return JSON.parse(source);
    } catch {
      throw failure(`${kind}_CORRUPT`, `The ${kind.toLowerCase()} file contains invalid JSON; existing evidence was not changed.`);
    }
  }

  async function read(enterprise) {
    const source = await readText(actionStatePath(enterprise), "STATE");
    return source === undefined ? emptyState(enterprise) : decodeState(parse(source, "STATE"), enterprise);
  }

  async function readSnapshot(enterprise) {
    const source = await readText(inventorySnapshotPath(enterprise), "SNAPSHOT");
    if (source === undefined) return null;
    const match = source.match(/^\s*window\.GITHUB_BILLING_SNAPSHOT\s*=\s*([\s\S]*);\s*$/);
    if (!match) throw failure("SNAPSHOT_CORRUPT", "The inventory file is not a snapshot assignment.");
    const snapshot = parse(match[1], "SNAPSHOT");
    if (!object(snapshot)) throw failure("SNAPSHOT_CORRUPT", "The inventory snapshot must contain an object.");
    if (![1, 2].includes(snapshot.schemaVersion)) {
      throw failure("SNAPSHOT_SCHEMA_UNSUPPORTED", "The inventory snapshot schema is unsupported.");
    }
    if (snapshot.enterprise !== enterprise) {
      throw failure("SNAPSHOT_ENTERPRISE_MISMATCH", "The inventory snapshot belongs to a different enterprise.");
    }
    if (snapshot.source !== "gh-api"
        || !["budgets", "costCenters", "enterpriseTeams"].every((key) => Array.isArray(snapshot[key]) && snapshot[key].every(object))
        || (snapshot.generatedAt !== undefined && !timestamp(snapshot.generatedAt))) {
      throw failure("SNAPSHOT_CORRUPT", "The inventory snapshot has an invalid shape.");
    }
    return { source: `window.GITHUB_BILLING_SNAPSHOT = ${JSON.stringify(snapshot)};\n`, snapshot };
  }

  async function retryFilesystem(action, attempts = 5, codes = retryCodes) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await action();
      } catch (error) {
        if (!codes.has(error?.code) || attempt >= attempts - 1) throw error;
        await delay(10 * (attempt + 1));
      }
    }
  }

  async function ensureOwned(lock) {
    let source;
    try {
      source = await fs.readFile(lock.path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") throw failure("LOCK_LOST", "The writer no longer owns its filesystem lock.");
      throw filesystemFailure(error, "LOCK_IO_FAILED", "Cannot verify filesystem lock ownership.");
    }
    let owner;
    try { owner = JSON.parse(source).owner; } catch { /* Incomplete locks are not authority to write. */ }
    if (owner !== lock.owner) throw failure("LOCK_LOST", "The writer no longer owns its filesystem lock.");
  }

  async function release(lock) {
    await ensureOwned(lock);
    try {
      await retryFilesystem(() => fs.unlink(lock.path));
    } catch (error) {
      throw filesystemFailure(error, "LOCK_IO_FAILED", "Cannot release the owned filesystem lock.");
    }
  }

  async function acquire(path) {
    try {
      await retryFilesystem(() => fs.mkdir(workspace, { recursive: true }));
    } catch (error) {
      throw filesystemFailure(error, "WORKSPACE_UNAVAILABLE", "Cannot use the session workspace for durable state.");
    }
    const lock = { path: `${path}.lock`, owner: randomUUID() };
    let handle;
    for (let attempt = 0; ; attempt++) {
      try {
        handle = await fs.open(lock.path, "wx", 0o600);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST" && !retryCodes.has(error?.code)) {
          throw filesystemFailure(error, "LOCK_IO_FAILED", "Cannot acquire a filesystem state lock.");
        }
        if (attempt >= 39) {
          if (error?.code === "EEXIST") throw failure("LOCK_BUSY", "Another writer or an interrupted writer owns the state lock; it was not removed.");
          throw filesystemFailure(error, "LOCK_IO_FAILED", "Filesystem lock retries were exhausted.");
        }
        await delay(10);
      }
    }
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, owner: lock.owner, pid: process.pid, createdAt: now() })}\n`, "utf8");
      await handle.sync();
      await handle.close();
    } catch (error) {
      try { await handle.close(); } catch { /* Preserve the original failure. */ }
      const reported = error?.errorCode ? error : filesystemFailure(error, "LOCK_IO_FAILED", "Cannot persist filesystem lock ownership.");
      try { await release(lock); } catch (cleanup) { reported.cleanupErrorCode = cleanup.code; }
      throw reported;
    }
    return lock;
  }

  async function withLock(path, action) {
    const lock = await acquire(path);
    let result;
    let error;
    try { result = await action(lock); } catch (caught) { error = caught; }
    try { await release(lock); } catch (cleanup) {
      if (error) error.cleanupErrorCode = cleanup.code;
      else error = cleanup;
    }
    if (error) throw error;
    return result;
  }

  async function atomicWrite(path, value, kind, lock) {
    const pending = `${path}.${randomUUID()}.pending`;
    let handle;
    let created = false;
    let replaced = false;
    let error;
    try {
      handle = await fs.open(pending, "wx", 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await ensureOwned(lock);
      // Windows sharing violations can surface as access errors during replacement.
      // Retry only the owned pending file rename, never the updater or dispatch.
      await retryFilesystem(() => fs.rename(pending, path), 5, replacementRetryCodes);
      replaced = true;
      // Node cannot portably fsync a directory on Windows. The file is flushed
      // before replace on all platforms; POSIX also flushes the directory entry.
      if (platform !== "win32") {
        const directory = await fs.open(workspace, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (caught) {
      error = caught?.errorCode ? caught : filesystemFailure(caught, `${kind}_WRITE_FAILED`, `Cannot atomically persist ${kind.toLowerCase()} data.`);
    } finally {
      if (handle) {
        try { await handle.close(); } catch (caught) {
          error ??= filesystemFailure(caught, `${kind}_WRITE_FAILED`, "Cannot close the pending state file.");
        }
      }
      if (created && !replaced) {
        try { await retryFilesystem(() => fs.unlink(pending)); } catch (caught) {
          if (caught?.code !== "ENOENT") {
            if (error) error.cleanupErrorCode = caught.code;
            else error = filesystemFailure(caught, `${kind}_WRITE_FAILED`, "Cannot remove the owned pending state file.");
          }
        }
      }
    }
    if (error) throw error;
  }

  async function update(enterprise, expectedRevision, updater) {
    const path = actionStatePath(enterprise);
    if (!revision(expectedRevision)) throw failure("INVALID_REVISION", "Expected revision must be a nonnegative safe integer.");
    if (typeof updater !== "function" || ["AsyncFunction", "GeneratorFunction", "AsyncGeneratorFunction"].includes(updater.constructor?.name)) {
      throw failure("INVALID_UPDATER", "State updaters must be synchronous state-only functions.");
    }
    return withLock(path, async (lock) => {
      const state = await read(enterprise);
      if (state.revision !== expectedRevision) {
        throw failure("REVISION_CONFLICT", "State changed before this update.", { expectedRevision, actualRevision: state.revision });
      }
      const draft = clone(state);
      const returned = updater(draft);
      if (returned && typeof returned.then === "function") {
        Promise.resolve(returned).catch(() => {});
        throw failure("INVALID_UPDATER", "State updaters must not return a promise.");
      }
      const value = returned === undefined ? draft : returned;
      if (!object(value) || value.schemaVersion !== 2) throw failure("STATE_CORRUPT", "An update must preserve the version 2 state shape.");
      if (value.revision !== expectedRevision) {
        throw failure("REVISION_CONFLICT", "Only the store can advance the state revision.", { expectedRevision, actualRevision: value.revision });
      }
      const next = decodeState(value, enterprise);
      if (state.revision === Number.MAX_SAFE_INTEGER) throw failure("REVISION_EXHAUSTED", "The state revision cannot advance safely.");
      next.revision++;
      const persisted = decodeState(redactSecrets(next), enterprise);
      await atomicWrite(path, persisted, "STATE", lock);
      return persisted;
    });
  }

  async function saveActionState(enterprise, state) {
    const normalized = decodeState(state, safeEnterpriseName(enterprise));
    const saved = await update(enterprise, normalized.revision, () => normalized);
    Object.assign(state, saved);
    return saved;
  }

  async function readJournal() {
    const source = await readText(journalPath, "JOURNAL");
    return source === undefined ? emptyJournal() : decodeJournal(parse(source, "JOURNAL"));
  }

  async function readDispatch(operationId) {
    if (operationId !== undefined && !identifier(operationId)) {
      throw failure("INVALID_OPERATION", "A server issued operation ID is required.");
    }
    const journal = await readJournal();
    const id = operationId ?? journal.activeOperationId;
    const entry = id && Object.hasOwn(journal.operations, id) ? journal.operations[id] : null;
    return entry ? dispatchResult(entry) : null;
  }

  async function saveJournal(journal, lock) {
    if (journal.revision === Number.MAX_SAFE_INTEGER) throw failure("REVISION_EXHAUSTED", "The journal revision cannot advance safely.");
    journal.revision++;
    await atomicWrite(journalPath, decodeJournal(journal), "JOURNAL", lock);
  }

  async function reserveDispatch(value) {
    const operation = normalizeOperation(value);
    const digest = intentDigest(operation);
    return withLock(journalPath, async (lock) => {
      const journal = await readJournal();
      const existing = Object.hasOwn(journal.operations, operation.operationId) ? journal.operations[operation.operationId] : null;
      if (existing) {
        if (existing.intentDigest !== digest) throw failure("DUPLICATE_OPERATION_CONFLICT", "This operation ID already identifies different dispatch intent.");
        return { reserved: false, operation: dispatchResult(existing) };
      }
      if (journal.activeOperationId !== null) {
        throw failure("DISPATCH_CONFLICT", "A session dispatch remains unresolved; a new operation cannot be sent.", {
          operationId: journal.activeOperationId,
          enterprise: journal.operations[journal.activeOperationId].operation.enterprise
        });
      }
      const entry = {
        operation, intentDigest: digest, reservedAt: now(),
        settledAt: null, outcome: null, terminal: false
      };
      journal.operations[operation.operationId] = entry;
      journal.activeOperationId = operation.operationId;
      await saveJournal(journal, lock);
      return { reserved: true, operation: dispatchResult(entry) };
    });
  }

  /**
   * Only server verified completion, or a server recorded dispatched:false
   * cancellation/block/failure, releases the barrier. Agent claims are not proof.
   * Duplicate calls return the persisted outcome, never permission to resend.
   */
  async function settleDispatch(operationId, value) {
    if (!identifier(operationId)) throw failure("INVALID_OPERATION", "A server issued operation ID is required.");
    const outcome = normalizeOutcome(value);
    return withLock(journalPath, async (lock) => {
      const journal = await readJournal();
      const entry = Object.hasOwn(journal.operations, operationId) ? journal.operations[operationId] : null;
      if (!entry) throw failure("DISPATCH_NOT_FOUND", "The operation has no durable dispatch reservation.");
      if (canonical(entry.outcome) === canonical(outcome)) {
        return { settled: entry.terminal, operation: dispatchResult(entry) };
      }
      if (entry.terminal) throw failure("DISPATCH_SETTLEMENT_CONFLICT", "A terminal dispatch outcome cannot be replaced.");
      entry.outcome = outcome;
      entry.terminal = terminalOutcome(outcome);
      entry.settledAt = now();
      if (entry.terminal) journal.activeOperationId = null;
      await saveJournal(journal, lock);
      return { settled: entry.terminal, operation: dispatchResult(entry) };
    });
  }

  return {
    read, readSnapshot, update, reserveDispatch, settleDispatch, readDispatch,
    loadActionState: read, saveActionState, inventorySnapshotPath
  };
}
