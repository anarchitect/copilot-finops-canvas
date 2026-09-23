(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CANVAS_BUDGET_MODEL = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const normalize = (value) => String(value || "").trim().toLowerCase();
  const creditSkus = new Set(["copilot_ai_credit", "coding_agent_ai_credit"]);
  const licenseSkus = new Set(["copilot_enterprise", "copilot_for_business", "copilot_standalone"]);
  const coverageReason = "Inventory establishes the visible collection only. Hidden budgets or assignments may change the effective allowance.";
  const overlapReason = "Official guidance conflicts on enterprise and narrower aggregate coverage. Verify the applicable scope and exclusion before relying on a combined limit.";

  function isAiBudget(budget) {
    const sku = normalize(budget?.budget_product_sku);
    const type = normalize(budget?.budget_type);
    if (sku === "ai_credits") return !type || type === "bundlepricing";
    return creditSkus.has(sku) && (!type || type === "skupricing");
  }

  function budgetKey(budget) {
    return JSON.stringify([
      budget.budget_scope, budgetEntityName(budget), budget.budget_type,
      budget.budget_product_sku, budget.id, budget.budget_amount,
      budget.consumed_amount, budget.prevent_further_usage
    ]);
  }

  function isUnresolvedAiBudget(budget) {
    const sku = normalize(budget?.budget_product_sku);
    return !isAiBudget(budget) && !licenseSkus.has(sku)
      && (sku === "copilot" || sku.includes("ai_credit") || sku.startsWith("copilot_") || sku.startsWith("coding_agent_"));
  }

  function relevantBudgets(budgets, scope, entityName = "") {
    return (Array.isArray(budgets) ? budgets : [])
      .filter((budget) => budget?.budget_scope === scope && (isAiBudget(budget) || isUnresolvedAiBudget(budget))
        && (!entityName || normalize(budgetEntityName(budget)) === normalize(entityName)))
      .sort((left, right) => budgetKey(left).localeCompare(budgetKey(right)));
  }

  function matchingBudgets(budgets, scope, entityName = "") {
    return (Array.isArray(budgets) ? budgets : [])
      .filter((budget) => budget?.budget_scope === scope && isAiBudget(budget)
        && (!entityName || normalize(budgetEntityName(budget)) === normalize(entityName)))
      .sort((left, right) => budgetKey(left).localeCompare(budgetKey(right)));
  }

  function findBudget(budgets, scope, entityName = "") {
    const matches = matchingBudgets(budgets, scope, entityName);
    return matches.length === 1 ? matches[0] : undefined;
  }

  function availableAmount(value) {
    return (typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
      && Number.isFinite(Number(value)) && Number(value) >= 0
      ? { state: "available", amount: Number(value) }
      : { state: "unavailable", amount: null };
  }

  function budgetEntityName(budget) {
    return String(budget?.user || budget?.budget_entity_name || budget?.entity_name || "").trim();
  }

  function explicitSeatOrganization(seat) {
    return String(seat?.organization?.login || seat?.organization?.name
      || seat?.assigning_organization?.login || seat?.assigning_organization?.name || "").trim();
  }

  function assignmentIndex(snapshot) {
    const direct = new Map();
    const teamAssignments = new Map();
    const organizations = new Map();
    const teams = new Map();
    let incompleteTeams = false;
    let incompleteCenters = !Array.isArray(snapshot?.costCenters);
    const add = (map, name, value) => {
      const key = normalize(name);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(value);
    };
    for (const team of snapshot?.enterpriseTeams || []) {
      for (const name of [team.name, team.slug, team.id].filter(Boolean)) teams.set(normalize(name), team);
    }
    for (const center of snapshot?.costCenters || []) {
      if (!center?.name || !Array.isArray(center.resources)) {
        incompleteCenters = true;
        continue;
      }
      for (const resource of center.resources) {
        const name = resource?.login || resource?.name || resource?.slug || resource?.id;
        const type = normalize(resource?.type).replaceAll("_", "").replaceAll("-", "");
        if (!name) {
          incompleteCenters = true;
        } else if (type === "user") {
          add(direct, name, { name: center.name });
        } else if (type === "organization") {
          add(organizations, name, { name: center.name });
        } else if (type === "team" || type === "enterpriseteam") {
          const team = teams.get(normalize(name));
          if (!Array.isArray(team?.members)) {
            incompleteTeams = true;
            continue;
          }
          for (const member of team.members) {
            const login = typeof member === "string" ? member : member?.login;
            if (!login) {
              incompleteTeams = true;
              continue;
            }
            add(teamAssignments, login, { name: center.name, createdAt: Date.parse(team.created_at) });
          }
        } else {
          incompleteCenters = true;
        }
      }
    }
    return { direct, teamAssignments, organizations, incompleteTeams, incompleteCenters };
  }

  function resolveCenter(index, login, organization) {
    const unavailable = (reason) => ({ state: "unavailable", name: null, reason });
    const unique = (items) => [...new Map(items.map((item) => [normalize(item.name), item.name])).values()];
    const direct = unique(index.direct.get(login) || []);
    if (direct.length === 1) return { state: "available", name: direct[0], source: "direct" };
    if (direct.length > 1) return unavailable("Conflicting direct assignments.");
    if (index.incompleteCenters) return unavailable("Cost center resources are incomplete.");
    if (index.incompleteTeams) return unavailable("Team membership is incomplete.");
    const teams = index.teamAssignments.get(login) || [];
    const teamCenters = unique(teams);
    if (teamCenters.length === 1) return { state: "available", name: teamCenters[0], source: "enterprise_team" };
    if (teamCenters.length > 1) {
      if (teams.some((team) => !Number.isFinite(team.createdAt))) {
        return unavailable("Competing team assignments need team creation evidence.");
      }
      const oldest = Math.min(...teams.map((team) => team.createdAt));
      const oldestCenters = unique(teams.filter((team) => team.createdAt === oldest));
      if (oldestCenters.length === 1) return { state: "available", name: oldestCenters[0], source: "earliest_enterprise_team" };
      return unavailable("Competing teams have indistinguishable creation times.");
    }
    if (organization.state === "available") {
      const centers = unique(index.organizations.get(normalize(organization.name)) || []);
      if (centers.length === 1) return { state: "available", name: centers[0], source: "licensing_organization" };
      if (centers.length > 1) return unavailable("Conflicting organization assignments.");
    } else if (index.organizations.size) {
      return unavailable("The billed licensing organization is not established.");
    }
    return { state: "not_assigned", name: null, source: "visible_inventory" };
  }

  function buildCostCenterUserMap(snapshot) {
    const index = assignmentIndex(snapshot);
    const logins = new Set([...index.direct.keys(), ...index.teamAssignments.keys()]);
    const result = new Map();
    for (const login of logins) {
      const center = resolveCenter(index, login, { state: "not_inventoried", name: null });
      if (center.state === "available") result.set(login, [center.name]);
    }
    return result;
  }

  function amountSelection(budgets, source) {
    if (!budgets.length) return { state: "unavailable", amount: null, present: false, source };
    if (budgets.length !== 1 || !isAiBudget(budgets[0])) {
      return { state: "unavailable", amount: null, present: true, source,
        reason: "Several observed budgets cover different or overlapping features; select and verify the feature scope." };
    }
    return { ...availableAmount(budgets[0].budget_amount), present: true, source };
  }

  function buildEffectiveBudgetChains(snapshot) {
    const rawBudgets = Array.isArray(snapshot?.budgets) ? snapshot.budgets : [];
    const budgets = rawBudgets.filter(isAiBudget);
    const unclassifiedBudgets = rawBudgets.filter(isUnresolvedAiBudget)
      .sort((left, right) => budgetKey(left).localeCompare(budgetKey(right)));
    const seats = Array.isArray(snapshot?.copilotSeats?.seats) ? snapshot.copilotSeats.seats : [];
    const index = assignmentIndex(snapshot);
    const users = new Map();
    const ensureUser = (login) => {
      const key = normalize(login);
      if (!key) return null;
      if (!users.has(key)) users.set(key, { username: String(login).trim(), organizations: new Map() });
      return users.get(key);
    };
    for (const seat of seats) {
      const user = ensureUser(seat?.assignee?.login || seat?.login);
      const organization = explicitSeatOrganization(seat);
      if (user && organization) user.organizations.set(normalize(organization), organization);
    }
    for (const budget of rawBudgets.filter((item) => item?.budget_scope === "user"
        && (isAiBudget(item) || isUnresolvedAiBudget(item)))) ensureUser(budgetEntityName(budget));
    for (const login of [...index.direct.keys(), ...index.teamAssignments.keys()]) ensureUser(login);
    const universal = relevantBudgets(rawBudgets, "multi_user_customer");
    const enterprise = matchingBudgets(budgets, "enterprise");

    return [...users.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([login, user]) => {
      const organization = user.organizations.size === 1
        ? { state: "available", name: [...user.organizations.values()][0], source: "single_observed_licensing_organization" }
        : { state: user.organizations.size ? "unavailable" : "not_inventoried", name: null,
          reason: "No single billed licensing organization is established for this cycle." };
      const costCenter = resolveCenter(index, login, organization);
      const individual = relevantBudgets(rawBudgets, "user", login);
      const centerBudgets = costCenter.state === "available"
        ? relevantBudgets(rawBudgets, "multi_user_cost_center", costCenter.name) : [];
      const individualUserBudget = amountSelection(individual, "Individual user budget");
      const costCenterUserBudget = amountSelection(centerBudgets, "Cost center per-user budget");
      const universalUserBudget = amountSelection(universal, "Universal per-user budget");
      const observed = individual.length ? individualUserBudget
        : costCenter.state === "unavailable"
          ? { state: "unavailable", amount: null, source: "Cost center assignment unresolved", reason: costCenter.reason }
          : centerBudgets.length ? costCenterUserBudget : universalUserBudget;
      const effectiveUserBudget = observed.state === "available"
        ? { ...observed, state: "unverified", reason: coverageReason }
        : { ...observed };
      const userConsumption = individual.length === 1 && isAiBudget(individual[0])
        ? availableAmount(individual[0].consumed_amount) : { state: "unavailable", amount: null };
      const userRemaining = observed.state === "available" && userConsumption.state === "available"
        ? { state: "unverified", amount: Math.max(0, observed.amount - userConsumption.amount), reason: coverageReason }
        : { state: "unavailable", amount: null };

      const aggregateCandidates = [];
      const append = (items, source, scope, applicability) => {
        for (const budget of items) {
          const amount = availableAmount(budget.budget_amount).amount;
          const consumed = availableAmount(budget.consumed_amount).amount;
          aggregateCandidates.push({
            budgetId: budget.id ?? null, budgetType: budget.budget_type ?? null,
            sku: budget.budget_product_sku, source, scope, applicability,
            amount, consumed, remaining: amount !== null && consumed !== null ? Math.max(0, amount - consumed) : null,
            hardStop: typeof budget.prevent_further_usage === "boolean" ? budget.prevent_further_usage : null,
            reportedCostCenterExclusion: typeof budget.exclude_cost_center_usage === "boolean"
              ? budget.exclude_cost_center_usage : null
          });
        }
      };
      if (costCenter.state === "available") {
        append(matchingBudgets(budgets, "cost_center", costCenter.name), "Cost center metered budget", costCenter.name, "observed_mapping");
      } else if (costCenter.state === "not_assigned" && organization.state === "available") {
        append(matchingBudgets(budgets, "organization", organization.name), "Organization metered budget", organization.name, "observed_mapping");
      }
      append(enterprise, "Enterprise metered budget", snapshot?.enterprise || "Enterprise",
        costCenter.state === "available" || aggregateCandidates.length ? "unverified_scope" : "observed_scope");
      const interpretationWarnings = [coverageReason];
      const aggregateOverlap = enterprise.length > 0 && (costCenter.state === "available"
        || aggregateCandidates.some((candidate) => candidate.source === "Organization metered budget"));
      if (aggregateOverlap) interpretationWarnings.push(overlapReason);
      if (costCenter.state === "unavailable") interpretationWarnings.push(costCenter.reason);
      const relevantUnclassified = unclassifiedBudgets.filter((budget) => {
        const entity = normalize(budgetEntityName(budget));
        if (budget.budget_scope === "user") return entity === login;
        if (["cost_center", "multi_user_cost_center"].includes(budget.budget_scope)) {
          return costCenter.state === "available" && entity === normalize(costCenter.name);
        }
        if (budget.budget_scope === "organization") return organization.state === "available" && entity === normalize(organization.name);
        return ["enterprise", "multi_user_customer"].includes(budget.budget_scope);
      });
      if (relevantUnclassified.length) interpretationWarnings.push("Potentially relevant product or AI budget coverage remains unresolved.");
      const features = new Set(aggregateCandidates.map((candidate) => normalize(candidate.sku)));
      if (features.size > 1) interpretationWarnings.push("Several AI credit feature scopes are present; a feature-specific limit has not been established.");
      const hardStops = aggregateCandidates.filter((candidate) => candidate.hardStop === true);
      const unknownStop = aggregateCandidates.some((candidate) => candidate.hardStop === null
        || (candidate.hardStop && candidate.remaining === null));
      const unresolved = aggregateOverlap || features.size > 1 || unknownStop
        || costCenter.state === "unavailable" || relevantUnclassified.length > 0;
      let aggregateMeteredBudget;
      if (unresolved) {
        aggregateMeteredBudget = { state: "unavailable", source: "Unresolved aggregate metered coverage", remaining: null,
          reason: unknownStop ? "An observed hard stop has unknown amount, consumption or enforcement." : interpretationWarnings.slice(1).join(" ") };
      } else if (hardStops.length) {
        const lowest = hardStops.reduce((left, right) => right.remaining < left.remaining ? right : left);
        aggregateMeteredBudget = { ...lowest, state: "unverified", reason: coverageReason };
      } else {
        aggregateMeteredBudget = { state: aggregateCandidates.length ? "monitoring_only" : "unavailable",
          source: aggregateCandidates.length ? "Observed budgets do not enforce a hard stop" : "No aggregate metered budget was observed",
          remaining: null, reason: coverageReason };
      }
      return {
        username: user.username, costCenter, organization,
        individualUserBudget, costCenterUserBudget, universalUserBudget,
        effectiveUserBudget, userConsumption, userRemaining,
        aggregateMeteredBudget, aggregateCandidates,
        lowestRemainingHeadroom: { state: "unavailable", amount: null, limitedBy: "Unverified applicable coverage", reason: coverageReason },
        coverage: { state: "unverified", reason: coverageReason },
        interpretationWarnings,
        unclassifiedBudgets: relevantUnclassified.map((budget) => ({
          budgetId: budget.id ?? null, budgetType: budget.budget_type ?? null,
          sku: budget.budget_product_sku, scope: budget.budget_scope, entity: budgetEntityName(budget),
          amount: availableAmount(budget.budget_amount).amount,
          consumed: availableAmount(budget.consumed_amount).amount,
          hardStop: typeof budget.prevent_further_usage === "boolean" ? budget.prevent_further_usage : null
        }))
      };
    });
  }
  return { isAiBudget, isUnresolvedAiBudget, findBudget, matchingBudgets, relevantBudgets, availableAmount, budgetEntityName, explicitSeatOrganization, buildCostCenterUserMap, buildEffectiveBudgetChains };
});
