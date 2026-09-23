(function (root) {
  const creditsPerSeat = Object.freeze({
    business: 1900,
    enterprise: 3900
  });

  const notInventoried = () => ({ state: "not_inventoried" });
  const unavailable = () => ({ state: "unavailable" });
  const available = (value) => ({ state: "available", value });

  function derivePoolCredits(copilotSeats) {
    if (!copilotSeats || !Number.isInteger(copilotSeats.total_seats)) return notInventoried();
    if (!Array.isArray(copilotSeats.seats)) return unavailable();

    const seatsByLogin = new Map();
    for (const seat of copilotSeats.seats) {
      const login = String(seat?.assignee?.login || "").toLowerCase();
      const planType = String(seat?.plan_type || "").toLowerCase();
      if (!login || !creditsPerSeat[planType]) return unavailable();
      const existingPlan = seatsByLogin.get(login);
      if (existingPlan && existingPlan !== planType) return unavailable();
      seatsByLogin.set(login, planType);
    }

    if (seatsByLogin.size !== copilotSeats.total_seats) return unavailable();
    return available([...seatsByLogin.values()]
      .reduce((total, planType) => total + creditsPerSeat[planType], 0));
  }

  function deriveAdditionalSpend(aiCreditUsage) {
    const supplied = aiCreditUsage?.filters;
    const filters = supplied && typeof supplied === "object" && !Array.isArray(supplied) ? { ...supplied } : {};
    for (const key of ["user", "organization", "product", "model", "costCenter"]) {
      if (!aiCreditUsage || !Object.hasOwn(aiCreditUsage, key)) continue;
      const reported = aiCreditUsage[key] ?? null;
      filters[key] = Object.hasOwn(filters, key) && JSON.stringify(filters[key]) !== JSON.stringify(reported)
        ? { requested: filters[key], reported, state: "conflicting" } : reported;
    }
    const scope = {
      period: aiCreditUsage?.timePeriod ?? null,
      filters: Object.keys(filters).length ? filters : null
    };
    if (!aiCreditUsage || !Array.isArray(aiCreditUsage.usageItems)) return { ...notInventoried(), ...scope };
    if (aiCreditUsage.usageItems.some((item) => !Number.isFinite(item?.netAmount))) return { ...unavailable(), ...scope };
    return { ...available(aiCreditUsage.usageItems
      .reduce((total, item) => total + item.netAmount, 0)), ...scope };
  }

  function deriveFinOpsMetrics(snapshot) {
    const copilotSeats = snapshot?.copilotSeats;
    const licenseCount = copilotSeats && Number.isInteger(copilotSeats.total_seats)
      ? available(copilotSeats.total_seats)
      : notInventoried();
    const poolCredits = derivePoolCredits(copilotSeats);
    const poolValue = poolCredits.state === "available"
      ? available(poolCredits.value / 100)
      : { state: poolCredits.state };

    return {
      licenseCount,
      poolCredits,
      poolValue,
      additionalSpend: deriveAdditionalSpend(snapshot?.aiCreditUsage)
    };
  }

  root.FINOPS_METRICS = Object.freeze({ deriveFinOpsMetrics });
})(window);
