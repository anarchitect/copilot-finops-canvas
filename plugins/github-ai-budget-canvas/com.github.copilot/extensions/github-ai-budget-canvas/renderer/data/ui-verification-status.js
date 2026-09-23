(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CANVAS_UI_VERIFICATION_STATUS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const UI_VERIFICATION_VALIDITY_MS = 30 * DAY_MS;
  const UI_VERIFICATION_EXPIRING_MS = 7 * DAY_MS;

  function stale(reason, verifiedAt = null, expiresAt = null) {
    return {
      status: "stale",
      isUsable: false,
      reason,
      verifiedAt,
      expiresAt
    };
  }

  function evaluateUiVerification(verification, expectedEnterprise, now = Date.now()) {
    if (!verification?.verifiedAt) return stale("missing");
    if (!expectedEnterprise || verification.enterprise !== expectedEnterprise) {
      return stale("enterprise-mismatch", verification.verifiedAt);
    }

    const verifiedAtMs = Date.parse(verification.verifiedAt);
    if (!Number.isFinite(verifiedAtMs)) return stale("invalid-timestamp", verification.verifiedAt);

    const expiresAtMs = verifiedAtMs + UI_VERIFICATION_VALIDITY_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();
    if (!Number.isFinite(now) || now >= expiresAtMs) {
      return stale("expired", verification.verifiedAt, expiresAt);
    }

    const status = now >= expiresAtMs - UI_VERIFICATION_EXPIRING_MS
      ? "expiring"
      : "fresh";
    return {
      status,
      isUsable: true,
      reason: status,
      verifiedAt: verification.verifiedAt,
      expiresAt
    };
  }

  return {
    UI_VERIFICATION_VALIDITY_MS,
    UI_VERIFICATION_EXPIRING_MS,
    evaluateUiVerification
  };
});
