import { isDeepStrictEqual } from "node:util";

const bindingFields = ["operationId", "actionId", "enterprise", "actor", "planDigest"];
// These are readback comparisons, not claims that a SKU or credential supports a write.
const budgetFields = {
  budget_amount: (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
  prevent_further_usage: (value) => typeof value === "boolean"
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function isText(value) {
  return typeof value === "string" && value.trim() !== ""
    && !/\[redacted\]|<redacted>|\*{3,}/i.test(value)
    && redactSecrets(value) === value;
}

function isTimestamp(value) {
  if (!isText(value)) return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour < 24 && minute < 60 && second < 60;
}

function isIdentifier(value) {
  return isText(value) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function sameKeys(value, keys) {
  return isRecord(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function validValues(value, fields) {
  return sameKeys(value, fields) && fields.every((field) =>
    Object.hasOwn(budgetFields, field) && budgetFields[field](value[field]));
}

function inspectPlan(plan) {
  const missing = [];
  const unsupported = [];
  if (!isRecord(plan)) return { missing: ["plan"], unsupported, fields: [], readOnly: false };
  for (const field of bindingFields) if (!isText(plan[field])) missing.push(field);
  if (plan.schemaVersion !== 1) missing.push("schemaVersion");
  if (!isText(plan.enterprise) || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(plan.enterprise)) missing.push("enterprise");
  const readOnly = plan.actionKind === "read-only" && plan.actionType === "read-only";
  if (!readOnly && !(plan.actionKind === "write" && plan.actionType === "update")) {
    unsupported.push("actionKind/actionType");
  }
  const target = plan.target;
  if (!isRecord(target)) {
    missing.push("target");
  } else {
    if (!["budget", "budgets"].includes(target.resourceType)) unsupported.push("target.resourceType");
    const keys = target.resourceType === "budgets"
      ? ["resourceType", "enterprise"] : ["resourceType", "enterprise", "resourceId"];
    if (!sameKeys(target, keys) || target.enterprise !== plan.enterprise
      || (target.resourceType !== "budgets" && !isIdentifier(target.resourceId))) missing.push("target");
    if (target.resourceType === "budgets" && !readOnly) unsupported.push("target.resourceType");
  }
  const fields = isRecord(plan.requestedChange) ? Object.keys(plan.requestedChange) : [];
  if (!isRecord(plan.requestedChange) || (!readOnly && fields.length === 0)) missing.push("requestedChange");
  if (fields.some((field) => !Object.hasOwn(budgetFields, field))) unsupported.push("requestedChange");
  else if (!validValues(plan.requestedChange, fields)) missing.push("requestedChange");
  if (target?.resourceType === "budgets" && fields.length) unsupported.push("postconditions");
  if (!Array.isArray(plan.postconditions)) {
    missing.push("postconditions");
  } else {
    const seen = new Set();
    for (const condition of plan.postconditions) {
      if (!sameKeys(condition, ["field", "operator", "value"])
        || !Object.hasOwn(budgetFields, condition.field) || condition.operator !== "equals") {
        unsupported.push("postconditions");
        continue;
      }
      if (seen.has(condition.field) || !fields.includes(condition.field)
        || !budgetFields[condition.field](condition.value)
        || condition.value !== plan.requestedChange[condition.field]) missing.push("postconditions");
      seen.add(condition.field);
    }
    if (seen.size !== fields.length || fields.some((field) => !seen.has(field))) missing.push("postconditions");
  }
  if (!readOnly) {
    if (!validValues(plan.beforeValues, fields)) missing.push("beforeValues");
    else if (fields.length && fields.every((field) => plan.beforeValues[field] === plan.requestedChange[field])) {
      missing.push("beforeValues.unchanged");
    }
  }
  for (const field of ["preparedAt", "dispatchedAt"]) {
    if (Object.hasOwn(plan, field) && !isTimestamp(plan[field])) missing.push(field);
  }
  if (isTimestamp(plan.preparedAt) && isTimestamp(plan.dispatchedAt)
    && Date.parse(plan.dispatchedAt) < Date.parse(plan.preparedAt)) missing.push("dispatchedAt");
  return { missing, unsupported, fields, readOnly };
}

function resourceId(data) {
  if (!isRecord(data)) return null;
  const ids = ["id", "budget_id"].filter((field) => Object.hasOwn(data, field)).map((field) => data[field]);
  if (!ids.length || ids.some((id) =>
    !(isIdentifier(id) || (Number.isSafeInteger(id) && id >= 0)))) return null;
  return ids.every((id) => String(id) === String(ids[0])) ? String(ids[0]) : null;
}

/**
 * Compare only explicit equals predicates on budget_amount and prevent_further_usage.
 * Read only goals can use empty requestedChange/postconditions to verify a resource read.
 * Budget data needs id or budget_id; collection data is an array or {budgets, total_count?}.
 * The service must pass readResource output directly, never an agent's claimed observation.
 * Returns {status: "verified"|"unverified"|"unsupported", reasons: string[], observation}.
 */
function verifyPostconditions(plan, observation) {
  const { missing, unsupported, fields } = inspectPlan(plan);
  const finish = (status, reasons) => ({
    status, reasons: [...new Set(reasons)], observation: redactSecrets(observation ?? null)
  });
  if (unsupported.length) return finish("unsupported", unsupported);
  if (missing.length) return finish("unverified", missing);
  if (!isRecord(observation)) return finish("unverified", ["observation"]);
  const reasons = [];
  if (observation.source !== "github-api") reasons.push("observation.source");
  if (observation.complete !== true) reasons.push("observation.complete");
  if (observation.exists !== true) reasons.push("observation.exists");
  if (observation.error || observation.errorCode
    || (Object.hasOwn(observation, "denied") && observation.denied !== false)
    || (Object.hasOwn(observation, "ok") && observation.ok !== true)
    || (Object.hasOwn(observation, "status")
      && (!Number.isInteger(observation.status) || observation.status < 200 || observation.status >= 300))) {
    reasons.push("observation.error");
  }
  for (const field of ["enterprise", "actor"]) {
    if (observation[field] !== plan[field]) reasons.push(`observation.${field}`);
  }
  for (const field of ["operationId", "actionId", "planDigest"]) {
    if (Object.hasOwn(observation, field) && observation[field] !== plan[field]) reasons.push(`observation.${field}`);
  }
  if (!isDeepStrictEqual(observation.target, plan.target)) reasons.push("observation.target");
  if (!isTimestamp(observation.observedAt)) reasons.push("observation.observedAt");
  const notBefore = plan.dispatchedAt ?? plan.preparedAt;
  if (notBefore && Date.parse(observation.observedAt) < Date.parse(notBefore)) reasons.push("observation.stale");
  const data = observation.data;
  if (plan.target.resourceType === "budget") {
    if (resourceId(data) !== plan.target.resourceId) reasons.push("observation.data.identity");
    if (isRecord(data) && Object.hasOwn(data, "enterprise") && data.enterprise !== plan.enterprise) {
      reasons.push("observation.data.enterprise");
    }
    for (const field of fields) {
      if (!isRecord(data) || !Object.hasOwn(data, field)
        || !budgetFields[field](data[field]) || data[field] !== plan.requestedChange[field]) {
        reasons.push(`observation.data.${field}`);
      }
    }
  } else {
    const budgets = Array.isArray(data) ? data : data?.budgets;
    if (!Array.isArray(budgets) || budgets.some((budget) => resourceId(budget) === null
      || (Object.hasOwn(budget, "enterprise") && budget.enterprise !== plan.enterprise))
      || new Set(budgets.map(resourceId)).size !== budgets.length
      || (isRecord(data) && Object.hasOwn(data, "total_count") && data.total_count !== budgets.length)) {
      reasons.push("observation.data");
    }
  }
  return finish(reasons.length ? "unverified" : "verified", reasons);
}

function redactSecrets(value, key = "") {
  if (/token|secret|password|authorization|cookie|credential/i.test(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSecrets(entryValue, entryKey)
      ])
    );
  }
  if (typeof value !== "string") return value;
  return value
    .replace(/("(?:token|secret|password|authorization|cookie|credential)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[A-Za-z0-9+/]+=*/gi, "******")
    .replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function stripAuditPayload(content) {
  return content
    .replace(/^\s*AUDIT_JSON:\s*```(?:json)?\s*[\s\S]*?```\s*$/im, "")
    .replace(/^\s*AUDIT_JSON:\s*\{.*\}\s*$/gim, "")
    .trim();
}

function parseAuditValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function extractAuditFields(content) {
  if (typeof content !== "string") return {};
  const fenced = content.match(/AUDIT_JSON:\s*```(?:json)?\s*([\s\S]*?)```/i);
  const inline = content.match(/^AUDIT_JSON:\s*(\{.*\})\s*$/im);
  const jsonSource = fenced?.[1] || inline?.[1];
  if (jsonSource) {
    try {
      const parsed = JSON.parse(jsonSource);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Labelled fields below may still provide a partial audit record.
    }
  }
  const labels = {
    ACTION_CODE: "actionCode",
    ENTERPRISE: "enterprise",
    ACTOR: "actor",
    AUTHENTICATED_ACCOUNT: "actor",
    REQUESTED_CHANGE: "requestedChange",
    BEFORE_VALUES: "beforeValues",
    AFTER_VALUES: "afterValues",
    EXECUTION_PATH: "executionPath",
    ENDPOINT_OR_INTERFACE_URL: "endpointOrInterfaceUrl",
    APPROVAL_EVIDENCE: "approvalEvidence",
    VERIFICATION_EVIDENCE: "verificationEvidence",
    RESULT: "result",
    TIMESTAMP: "timestamp",
    RESULT_URL: "resultUrl"
  };
  const parsed = {};
  for (const [label, field] of Object.entries(labels)) {
    const match = content.match(new RegExp(`^${label}:\\s*(.+)$`, "im"));
    if (match) parsed[field] = parseAuditValue(match[1]);
  }
  return parsed;
}

function isBudgetUrl(value, operation, executionPath = "ui") {
  if (!isText(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) return false;
    const enterprise = operation?.enterprise;
    const base = `/enterprises/${enterprise}`;
    if (executionPath === "api") {
      const route = `${base}/settings/billing/budgets`;
      return url.hostname === "api.github.com" && url.pathname === (operation?.target?.resourceType === "budgets"
        ? route : `${route}/${operation?.target?.resourceId}`);
    }
    return url.hostname === "github.com"
      && [`${base}/billing/budgets`, `${base}/settings/billing/budgets`].includes(url.pathname);
  } catch {
    return false;
  }
}

function validApproval(approval, operation) {
  if (!isRecord(approval) || approval.source !== "host-confirmation" || approval.approved !== true
    || !isTimestamp(approval.approvedAt)) return false;
  for (const field of ["operationId", "planDigest", "enterprise", "actor"]) {
    if (!isText(approval[field]) || approval[field] !== operation[field]) return false;
  }
  for (const field of ["actionId", "actionKind", "actionType", "target", "requestedChange"]) {
    if (Object.hasOwn(approval, field) && !isDeepStrictEqual(approval[field], operation[field])) return false;
  }
  return (!operation.dispatchedAt || Date.parse(approval.approvedAt) <= Date.parse(operation.dispatchedAt))
    && (!operation.preparedAt || Date.parse(approval.approvedAt) >= Date.parse(operation.preparedAt));
}

/**
 * Claim: operation bindings, requestedChange, executionPath, endpointOrInterfaceUrl,
 * verificationEvidence (observation shape), result:"completed", timestamp, resultUrl.
 * Updates also need typed beforeValues/afterValues containing exactly the requested keys.
 * recordedApproval comes directly from host confirmation, never from claim.approvalEvidence.
 * Returns {complete, missingFields, record}; the redacted record repeats complete/missingFields.
 * Completeness validates structure only. The service must also call verifyPostconditions
 * with its own independent read. Read only goals need neither approval nor mutation values.
 */
function validateAudit(claim, operation, recordedApproval) {
  const supplied = typeof claim === "string" ? extractAuditFields(claim) : isRecord(claim) ? claim : {};
  const plan = isRecord(operation) ? operation : {};
  const { missing, unsupported, fields, readOnly } = inspectPlan(operation);
  const missingFields = [...missing, ...unsupported];
  const requireField = (field, valid) => { if (!valid) missingFields.push(field); };
  if (typeof claim === "string" && (claim.match(/AUDIT_JSON:/gi)?.length ?? 0) > 1) {
    requireField("claim", false);
  }
  requireField("schemaVersion", supplied.schemaVersion === 1);
  for (const field of bindingFields) {
    requireField(field, isText(supplied[field]) && supplied[field] === plan[field]);
  }
  for (const field of ["actionKind", "actionType", "target", "requestedChange"]) {
    requireField(field, Object.hasOwn(supplied, field) && isDeepStrictEqual(supplied[field], plan[field]));
  }
  if (Object.hasOwn(supplied, "actionCode")) requireField("actionCode", supplied.actionCode === plan.actionId);
  if (Object.hasOwn(supplied, "postconditions")) {
    requireField("postconditions", isDeepStrictEqual(supplied.postconditions, plan.postconditions));
  }
  if (!readOnly) {
    requireField("beforeValues", validValues(supplied.beforeValues, fields)
      && isDeepStrictEqual(supplied.beforeValues, plan.beforeValues));
    requireField("afterValues", validValues(supplied.afterValues, fields)
      && isDeepStrictEqual(supplied.afterValues, plan.requestedChange));
    requireField("approvalEvidence", validApproval(recordedApproval, plan));
  }
  requireField("executionPath", ["api", "ui"].includes(supplied.executionPath));
  requireField("endpointOrInterfaceUrl", isBudgetUrl(supplied.endpointOrInterfaceUrl, plan, supplied.executionPath));
  requireField("resultUrl", isBudgetUrl(supplied.resultUrl, plan));
  requireField("result", supplied.result === "completed"
    && !(typeof claim === "string" && /^\s*(?:BLOCKED|UNVERIFIED|FAILED):/i.test(claim)));
  requireField("timestamp", isTimestamp(supplied.timestamp));
  const evidence = supplied.verificationEvidence;
  requireField("verificationEvidence", verifyPostconditions(plan, evidence).status === "verified");
  if (isTimestamp(evidence?.observedAt) && isTimestamp(supplied.timestamp)) {
    requireField("timestamp", Date.parse(supplied.timestamp) >= Date.parse(evidence.observedAt));
  }
  if (!readOnly && isTimestamp(recordedApproval?.approvedAt)) {
    requireField("approvalEvidence", Date.parse(recordedApproval.approvedAt) <= Date.parse(supplied.timestamp)
      && Date.parse(recordedApproval.approvedAt) <= Date.parse(evidence?.observedAt));
  }
  const uniqueMissing = [...new Set(missingFields)];
  const record = { ...supplied };
  // An agent's approval field is never persisted as approval authority.
  delete record.approvalEvidence;
  if (!readOnly) record.approvalEvidence = recordedApproval ?? null;
  record.complete = uniqueMissing.length === 0;
  record.missingFields = uniqueMissing;
  return { complete: record.complete, missingFields: uniqueMissing, record: redactSecrets(record) };
}

function buildAuditRecord(content, context = {}) {
  const supplied = extractAuditFields(content);
  const normalizedPath = typeof supplied.executionPath === "string"
    ? supplied.executionPath.trim().toLowerCase()
    : supplied.executionPath;
  const record = {
    schemaVersion: 1,
    actionCode: context.actionCode,
    enterprise: context.enterprise,
    actor: Object.hasOwn(supplied, "actor") ? supplied.actor : context.actor || null,
    requestedChange: Object.hasOwn(supplied, "requestedChange")
      ? supplied.requestedChange
      : context.requestedChange,
    beforeValues: Object.hasOwn(supplied, "beforeValues") ? supplied.beforeValues : null,
    afterValues: Object.hasOwn(supplied, "afterValues") ? supplied.afterValues : null,
    executionPath: ["api", "ui"].includes(normalizedPath) ? normalizedPath : null,
    endpointOrInterfaceUrl: Object.hasOwn(supplied, "endpointOrInterfaceUrl")
      ? supplied.endpointOrInterfaceUrl
      : null,
    approvalEvidence: Object.hasOwn(supplied, "approvalEvidence")
      ? supplied.approvalEvidence
      : null,
    verificationEvidence: Object.hasOwn(supplied, "verificationEvidence")
      ? supplied.verificationEvidence
      : null,
    result: context.result,
    timestamp: Number.isNaN(Date.parse(supplied.timestamp))
      ? context.timestamp
      : supplied.timestamp,
    resultUrl: Object.hasOwn(supplied, "resultUrl") ? supplied.resultUrl : context.resultUrl
  };
  const validated = validateAudit(content, context.operation ?? context, context.recordedApproval);
  return redactSecrets({
    ...(validated.complete ? { actionCode: context.actionCode ?? supplied.actionId, ...validated.record } : record),
    approvalEvidence: validated.record.approvalEvidence ?? null,
    complete: validated.complete,
    missingFields: validated.missingFields
  });
}

function incompleteLegacyAudit(enterprise, actionCode, result, timestamp = "", resultUrl = "") {
  return {
    schemaVersion: 1,
    actionCode,
    enterprise,
    actor: null,
    requestedChange: null,
    beforeValues: null,
    afterValues: null,
    executionPath: null,
    endpointOrInterfaceUrl: null,
    approvalEvidence: null,
    verificationEvidence: null,
    result,
    timestamp,
    resultUrl,
    complete: false,
    missingFields: [
      "actor",
      "requestedChange",
      "beforeValues",
      "afterValues",
      "executionPath",
      "endpointOrInterfaceUrl",
      "approvalEvidence",
      "verificationEvidence"
    ]
  };
}

function normalizeLegacyRecord(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {
    ...fallback,
    message: typeof value === "string" ? value : fallback.message
  };
}

function extractResponseContent(response) {
  const content = response?.data?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text || "").join("\n");
  }
  return content ? JSON.stringify(content) : "";
}

function normalizeRollback(value, actionType, enterprise) {
  const supplied = value && typeof value === "object" ? value : {};
  const collectionRoute = `/enterprises/${enterprise}/settings/billing/budgets`;
  const defaults = {
    create: {
      summary: "Delete the newly created GitHub billing budget if validation shows it is incorrect.",
      dataRequired: "Created resource ID and full creation response.",
      route: `GitHub enterprise billing budgets interface and DELETE ${collectionRoute}/{budget_id}`
    },
    update: {
      summary: "Restore the previous GitHub billing budget values.",
      dataRequired: "Resource ID and previous values for every changed field.",
      route: `GitHub enterprise billing budgets interface and PATCH ${collectionRoute}/{budget_id}`
    },
    delete: {
      summary: "Recreate the deleted GitHub billing budget with its previous configuration.",
      dataRequired: "Full exported configuration before deletion.",
      route: `GitHub enterprise billing budgets interface and POST ${collectionRoute}`
    },
    "read-only": {
      summary: "No rollback required. This action only reads or verifies current GitHub settings.",
      dataRequired: "None.",
      route: `GitHub enterprise billing budgets interface and GET ${collectionRoute}`
    },
    blocked: {
      summary: "No rollback required. Validation blocked the action before mutation.",
      dataRequired: "None.",
      route: `GitHub enterprise billing budgets interface and ${collectionRoute}`
    },
    waived: {
      summary: "No rollback required. A waiver records a decision and does not mutate GitHub.",
      dataRequired: "None.",
      route: `GitHub enterprise billing budgets interface and ${collectionRoute}`
    },
    unknown: {
      summary: "Define and approve rollback during preflight before any mutation.",
      dataRequired: "Resource ID, current configuration export, and every field that may change.",
      route: `GitHub enterprise billing budgets interface and ${collectionRoute}`
    }
  };
  const fallback = defaults[actionType] || defaults.unknown;
  const normalized = {
    summary: String(supplied.summary || fallback.summary).trim(),
    dataRequired: String(supplied.dataRequired || fallback.dataRequired).trim(),
    route: String(supplied.route || fallback.route).trim()
  };
  if (Object.values(normalized).some((field) => !field || field.length > 2000)) {
    throw new Error("Rollback guidance must include concise summary, data, and route fields.");
  }
  return normalized;
}

function extractResultUrl(content) {
  const match = content.match(/^RESULT_URL:\s*(https:\/\/\S+)/im);
  return match?.[1] || "";
}

export { redactSecrets, stripAuditPayload, parseAuditValue, extractAuditFields, buildAuditRecord, incompleteLegacyAudit, normalizeLegacyRecord, extractResponseContent, normalizeRollback, extractResultUrl, validateAudit, verifyPostconditions };
