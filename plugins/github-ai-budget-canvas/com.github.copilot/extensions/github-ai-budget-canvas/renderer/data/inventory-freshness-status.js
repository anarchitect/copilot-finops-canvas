(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CANVAS_INVENTORY_FRESHNESS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const HOUR_MS = 60 * 60 * 1000;
  const DEFAULT_THRESHOLDS = Object.freeze({
    expiringAfterMs: 20 * HOUR_MS,
    staleAfterMs: 24 * HOUR_MS
  });

  function stale(reason, snapshot, thresholds, generatedAt = null) {
    return {
      status: "stale",
      isUsable: false,
      reason,
      generatedAt,
      ageMs: null,
      expiringAt: null,
      expiresAt: null,
      nextRefreshAt: null,
      thresholds,
      enterprise: snapshot?.enterprise || null
    };
  }

  function normalizeThresholds(configured = {}) {
    const expiringAfterMs = Number(configured.expiringAfterMs);
    const staleAfterMs = Number(configured.staleAfterMs);
    return {
      expiringAfterMs: Number.isFinite(expiringAfterMs) && expiringAfterMs >= 0
        ? expiringAfterMs
        : DEFAULT_THRESHOLDS.expiringAfterMs,
      staleAfterMs: Number.isFinite(staleAfterMs)
        && staleAfterMs > 0
        && staleAfterMs >= (Number.isFinite(expiringAfterMs) ? expiringAfterMs : DEFAULT_THRESHOLDS.expiringAfterMs)
        ? staleAfterMs
        : DEFAULT_THRESHOLDS.staleAfterMs
    };
  }

  function evaluateInventoryFreshness(snapshot, expectedEnterprise, now = Date.now(), configuredThresholds) {
    const thresholds = normalizeThresholds(configuredThresholds);
    if (snapshot?.source !== "gh-api") return stale("missing", snapshot, thresholds);
    if (!expectedEnterprise || snapshot.enterprise !== expectedEnterprise) {
      return stale("enterprise-mismatch", snapshot, thresholds, snapshot.generatedAt || null);
    }
    if (!snapshot.generatedAt) return stale("missing-timestamp", snapshot, thresholds);

    const generatedAtMs = Date.parse(snapshot.generatedAt);
    if (!Number.isFinite(generatedAtMs)) {
      return stale("invalid-timestamp", snapshot, thresholds, snapshot.generatedAt);
    }
    if (!Number.isFinite(now)) return stale("invalid-clock", snapshot, thresholds, snapshot.generatedAt);

    const ageMs = now - generatedAtMs;
    if (ageMs < 0) return stale("clock-skew", snapshot, thresholds, snapshot.generatedAt);

    const expiringAtMs = generatedAtMs + thresholds.expiringAfterMs;
    const expiresAtMs = generatedAtMs + thresholds.staleAfterMs;
    const status = ageMs >= thresholds.staleAfterMs
      ? "stale"
      : ageMs >= thresholds.expiringAfterMs
        ? "expiring"
        : "fresh";

    return {
      status,
      isUsable: status !== "stale",
      reason: status,
      generatedAt: snapshot.generatedAt,
      ageMs,
      expiringAt: new Date(expiringAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      nextRefreshAt: new Date(expiresAtMs).toISOString(),
      thresholds,
      enterprise: snapshot.enterprise
    };
  }

  return {
    HOUR_MS,
    DEFAULT_THRESHOLDS,
    normalizeThresholds,
    evaluateInventoryFreshness
  };
});
