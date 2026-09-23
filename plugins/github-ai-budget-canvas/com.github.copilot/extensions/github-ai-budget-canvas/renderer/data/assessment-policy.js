(function (root, factory) {
  const commonjs = typeof module === "object" && module.exports;
  const api = factory(
    commonjs ? require("./budget-model.js") : root.CANVAS_BUDGET_MODEL,
    commonjs ? require("./inventory-freshness-status.js") : root.CANVAS_INVENTORY_FRESHNESS,
    commonjs ? require("./ui-verification-status.js") : root.CANVAS_UI_VERIFICATION_STATUS
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CANVAS_ASSESSMENT_POLICY = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (model, freshness, uiVerification) {
  const money = (value) => Number.isFinite(value) ? `$${value.toFixed(2)}` : "Unavailable";
  function buildAssessment(snapshot, scenario) {
  const { settings, users } = scenario;
  const must = [];
  const should = [];
  const could = [];
  const notNow = [];
  const recommendation = (code, risk, action, priorityScore, subject = "", options = {}) => ({
    code,
    risk,
    action,
    priorityScore,
    subject,
    actionType: options.actionType || "unknown",
    rollbackResource: options.rollbackResource || "GitHub billing budget",
    rollbackData: options.rollbackData || "resource configuration",
    actionKind: options.actionKind || (options.actionType === "read-only" ? "read-only" : "write"),
    requiresUiVerification: Boolean(options.requiresUiVerification),
    dependsOnMust: [...(options.dependsOnMust || [])]
  });

  const objective = ["monitor", "hard_cap"].includes(settings.budgetObjective) ? settings.budgetObjective : "unknown";
  const wantsHardCap = objective === "hard_cap" && settings.paidUsage === true;
  const enterpriseBudgets = model.relevantBudgets(snapshot?.budgets, "enterprise");
  if (wantsHardCap && settings.enterpriseBudget === null && enterpriseBudgets.length === 0) {
    must.push(recommendation(
      "enterprise-cap-missing",
      "The scenario requires a hard cap, but no enterprise AI credit spending limit was returned in the visible inventory.",
      "Confirm complete budget coverage and the intended scope before sizing any new limit. Missing from this inventory does not prove absent.",
      20,
      "",
      { actionType: "create", rollbackResource: "enterprise AI credits budget" }
    ));
  } else if (enterpriseBudgets.length > 1 || enterpriseBudgets.some((item) => !model.isAiBudget(item))
      || settings.enterpriseBudgetState === "unavailable") {
    must.push(recommendation(
      "enterprise-budget-scope-unverified",
      "The enterprise budget amount or applicable feature scope is unresolved.",
      "Review every returned bundle and SKU limit before choosing a target. Do not infer a larger allowance from one budget.",
      15, "", { actionType: "read-only" }
    ));
  } else if (settings.enterpriseBudget !== null && settings.enterpriseStop === false
      && objective !== "monitor" && settings.paidUsage !== false) {
    must.push(recommendation(
      "enterprise-stop-usage-disabled",
      wantsHardCap
        ? "The explicit scenario requires a hard cap, but the observed enterprise budget is monitoring only."
        : "A monitoring budget is present. The paid usage policy or the owner's choice between continuity and a hard cap is unconfirmed.",
      wantsHardCap
        ? "Review the exact enterprise target and explicitly approve enabling stop usage."
        : "Confirm the paid usage scenario and budget objective. Monitoring without blocking can be intentional.",
      20,
      "",
      { actionType: wantsHardCap ? "update" : "read-only", rollbackResource: "enterprise Copilot spending limit", rollbackData: "stop usage setting" }
    ));
  }

  if (settings.costCenter.includedControl && settings.costCenter.poolRemainingCredits === 0) {
    if (settings.costCenter.includedAction === "unknown") {
      must.push(recommendation(
        "cost-center-included-action-unknown",
        `${settings.costCenter.name || "The selected cost center"} has no included credits remaining, but the API inventory does not expose whether the cap blocks or permits overage.`,
        "Verify the included usage cap behaviour in GitHub before recommending another control change.",
        10,
        "",
        { actionType: "read-only", rollbackResource: "cost center included usage control" }
      ));
    } else if (settings.costCenter.includedAction === "block") {
      must.push(recommendation(
        "cost-center-included-action-block",
        `${settings.costCenter.name || "The selected cost center"} has no included credits remaining and is configured to block.`,
        "Confirm whether to keep the block or allow controlled paid overage.",
        10,
        "",
        { actionType: "read-only", rollbackResource: "cost center included usage control", requiresUiVerification: true }
      ));
    } else {
      must.push(recommendation(
        "cost-center-overage-unprotected",
        settings.paidUsage === false
          ? `${settings.costCenter.name || "The selected cost center"} has no included credits remaining. Paid usage is disabled in this scenario, so the included overage setting does not enable metering.`
          : settings.paidUsage === true
            ? `${settings.costCenter.name || "The selected cost center"} has no included credits remaining. The scenario permits paid overage, but other applicable controls can still block it.`
            : `${settings.costCenter.name || "The selected cost center"} has no included credits remaining. Its overage setting does not establish whether the unknown paid usage policy permits metering.`,
        "Confirm the paid usage policy, intended outcome and applicable spending limits before relying on overage.",
        10,
        "",
        { actionType: "read-only", rollbackResource: "cost center spending limit", requiresUiVerification: true }
      ));
    }
  }

  if (settings.excludeCostCenters) {
    must.push(recommendation(
      "cost-center-exclusion-enabled",
      "An exclusion value was returned or entered, but its applicable cost center and effect on enterprise coverage are unverified.",
      "Verify the scoped exclusion and the intended control. Official aggregate budget descriptions conflict; do not infer that all cost centers are excluded.",
      30,
      "",
      { actionType: "read-only", rollbackResource: "cost center exclusion setting", requiresUiVerification: true }
    ));
  }

  const supportedSpendingBudgets = (snapshot?.budgets || [])
    .filter((budget) => model.isAiBudget(budget)
      && ["enterprise", "organization", "repository", "cost_center"].includes(budget.budget_scope));
  const budgetsMissingAlertOwners = supportedSpendingBudgets.filter((budget) =>
    !budget.budget_alerting?.will_alert
    || !Array.isArray(budget.budget_alerting?.alert_recipients)
    || budget.budget_alerting.alert_recipients.length === 0
  );
  if (budgetsMissingAlertOwners.length > 0) {
    should.push(recommendation(
      "spending-budget-alert-owner-missing",
      `${budgetsMissingAlertOwners.length} visible spending budget${budgetsMissingAlertOwners.length === 1 ? " has" : "s have"} disabled, unavailable or unspecified additional alert delivery details. Empty recipients do not establish that no one receives alerts.`,
      "Confirm alerting intent and delivery to default owners or billing managers before adding recipients.",
      60,
      "",
      { actionType: "read-only", rollbackResource: "budget alert configuration" }
    ));
  }

  const selectedCostCenter = (snapshot?.costCenters || [])
    .find((center) => center.name === settings.costCenter.name);
  const teamResources = (selectedCostCenter?.resources || [])
    .filter((resource) => String(resource.type || "").toLowerCase().includes("team"));
  const missingTeamExpansion = teamResources.some((resource) => {
    const resourceName = String(resource.name || "").toLowerCase();
    const team = (snapshot?.enterpriseTeams || []).find((candidate) =>
      String(candidate.slug || "").toLowerCase() === resourceName
      || String(candidate.name || "").toLowerCase() === resourceName
    );
    return !team || !Array.isArray(team.members);
  });
  if (missingTeamExpansion) {
    should.push(recommendation(
      "team-membership-expansion",
      "Team based assignment can hide each user's effective cost center.",
      "Expand enterprise team membership in inventory and reporting.",
      30,
      "",
      { actionType: "read-only", rollbackResource: "enterprise team membership inventory" }
    ));
  }
  if (settings.costCenter.includedControl && settings.costCenter.poolRemainingCredits > 0) {
    should.push(recommendation(
      "cost-center-included-behaviour-document",
      "Included usage cap behaviour determines whether cost center users block or incur overage.",
      "Document the intended behaviour and approval owner.",
      10,
      "",
      {
        actionType: "read-only",
        rollbackResource: "cost center included usage control",
        dependsOnMust: [
          "must-cost-center-included-action-unknown",
          "must-cost-center-included-action-block",
          "must-cost-center-overage-unprotected"
        ]
      }
    ));
  }
  const centerSpending = settings.costCenter.name
    ? model.relevantBudgets(snapshot?.budgets, "cost_center", settings.costCenter.name) : [];
  const unresolvedCenterSpending = centerSpending.length > 1 || centerSpending.some((budget) =>
    !model.isAiBudget(budget) || model.availableAmount(budget.budget_amount).state !== "available");
  if (unresolvedCenterSpending) {
    should.push(recommendation(
      "cost-center-cap-unverified",
      `${settings.costCenter.name} has observed spending controls, but their amount or feature coverage is unresolved.`,
      "Review the returned controls before proposing another budget. Unresolved is not absent.",
      20, settings.costCenter.name, { actionType: "read-only", rollbackResource: "cost center spending limit" }
    ));
  } else if (settings.paidUsage && settings.costCenter.name && settings.costCenter.spendingBudget === null && centerSpending.length === 0) {
    should.push(recommendation(
      "cost-center-cap-missing",
      `No AI credit spending limit for ${settings.costCenter.name} was returned in the visible inventory.`,
      "Confirm budget visibility and scope before sizing any new cost center limit for the intended paid overage objective.",
      20,
      settings.costCenter.name,
      {
        actionType: "create",
        rollbackResource: "cost center AI credits budget",
        dependsOnMust: [
          "must-cost-center-included-action-unknown",
          "must-cost-center-included-action-block",
          "must-cost-center-overage-unprotected",
          "must-cost-center-exclusion-enabled"
        ]
      }
    ));
  }
  users
    .filter((user) => user.hasIndividualBudget || (user.individualBudget !== null && user.individualBudget !== undefined))
    .forEach((user) => should.push(recommendation(
      "individual-budget-review",
      `${user.username} has an observed individual budget of ${money(user.individualBudget)}; ${Number.isFinite(user.consumed) ? `recorded consumption is ${money(user.consumed)}` : "consumption is unavailable"}.`,
      "Confirm the exception owner, business need, and expiry date.",
      40,
      user.username,
      { actionType: "read-only", rollbackResource: `${user.username} individual budget exception` }
    )));

  could.push({ code: "compare-two-billing-cycles", action: "Use the AI usage CSV to compare consumption by user, model, and cost center over two complete billing cycles." });
  could.push({ code: "apply-model-policies", action: "Apply model policies if premium model selection, rather than broad adoption, is driving most of the additional spend." });
  could.push({ code: "name-exception-owner", action: "Name an operational owner who can approve exceptions before users are blocked." });

  notNow.push({ code: "alert-only-not-hard-cap", action: "Do not treat alert only budgets as hard spending caps." });
  notNow.push({ code: "unprotected-cost-center-exclusion", action: "Do not infer global exclusion or exact aggregate blocking from an unverified flag or conflicting scope descriptions." });
  notNow.push({ code: "overlapping-budget-controls", action: "Do not create overlapping product and SKU budgets unless the blocking interaction is intentional." });
  notNow.push({ code: "multi-org-budget-duplication", action: "Do not add organization budgets solely for users licensed through multiple organizations. Prefer predictable cost center assignment." });

  return { must, should, could, notNow };
  }
  function actionId(category, item) {
  return `${category}-${item.code}${item.subject ? `-${encodeURIComponent(item.subject)}` : ""}`;
  }
  function resolveAction(id, assessment) {
  for (const category of ["must", "should"]) {
    const action = assessment[category].find((item) => actionId(category, item) === id);
    if (action) return { ...action, id, category };
  }
  return null;
  }
  function snapshotScenario(snapshot, selection = {}, uiFacts, now = Date.now()) {
    const budgets = snapshot.budgets || [];
    const center = selection.costCenterName
      ? (snapshot.costCenters || []).find((item) => item.name === selection.costCenterName)
      : (snapshot.costCenters || []).find((item) => item.ai_credit_pool_enabled) || snapshot.costCenters?.[0];
    if (selection.costCenterName && !center) throw new Error("Selected cost center is not inventoried.");
    const enterpriseCandidates = model.relevantBudgets(budgets, "enterprise");
    const enterprise = model.findBudget(budgets, "enterprise");
    const spending = center && model.findBudget(budgets, "cost_center", center.name);
    const spendingCandidates = center ? model.relevantBudgets(budgets, "cost_center", center.name) : [];
    const amount = (value) => model.availableAmount(value).amount;
    const target = amount(center?.ai_credit_pool_state?.target_amount);
    const used = amount(center?.ai_credit_pool_state?.current_amount);
    const uiAction = uiVerification.evaluateUiVerification(uiFacts, snapshot.enterprise, now).isUsable
      ? uiFacts?.costCenters?.[center?.name]?.includedUsageAction
      : null;
    return {
      settings: {
        paidUsage: typeof selection.paidUsage === "boolean" ? selection.paidUsage : null,
        budgetObjective: ["monitor", "hard_cap"].includes(selection.budgetObjective) ? selection.budgetObjective : "unknown",
        scenarioSource: "operator-scenario",
        enterpriseBudget: amount(enterprise?.budget_amount),
        enterpriseBudgetState: enterpriseCandidates.length === 0 ? "absent"
          : enterpriseCandidates.length === 1 && amount(enterprise?.budget_amount) !== null ? "available" : "unavailable",
        enterpriseStop: typeof enterprise?.prevent_further_usage === "boolean" ? enterprise.prevent_further_usage : null,
        excludeCostCenters: typeof enterprise?.exclude_cost_center_usage === "boolean" ? enterprise.exclude_cost_center_usage : null,
        costCenter: {
          name: center?.name || "",
          includedControl: center?.ai_credit_pool_enabled === true,
          includedAction: ["block", "overage"].includes(uiAction) ? uiAction : "unknown",
          poolRemainingCredits: target !== null && used !== null ? Math.max(0, target - used) : null,
          spendingBudget: amount(spending?.budget_amount),
          spendingBudgetState: spendingCandidates.length === 0 ? "absent"
            : spendingCandidates.length === 1 && model.isAiBudget(spendingCandidates[0]) && amount(spending?.budget_amount) !== null
              ? "available" : "unavailable"
        }
      },
      users: model.buildEffectiveBudgetChains(snapshot).map((user) => ({
        username: user.username,
        hasIndividualBudget: user.individualUserBudget.present,
        individualBudget: user.individualUserBudget.amount,
        consumed: user.userConsumption.amount
      }))
    };
  }

  function evaluateEligibility(action, context) {
    const reasons = [];
    const inventory = freshness.evaluateInventoryFreshness(context.snapshot, context.enterprise, context.now);
    if (!inventory.isUsable) reasons.push({ code: "STALE_INVENTORY", detail: inventory.reason });
    if (!action) reasons.push({ code: "INVALID_INPUT", detail: "Recommendation is not active." });
    if (action?.requiresUiVerification
      && !uiVerification.evaluateUiVerification(context.uiFacts, context.enterprise, context.now).isUsable) {
      reasons.push({ code: "UI_FACT_STALE", detail: "Revalidate the required GitHub UI fact." });
    }
    const active = new Set((context.assessment?.must || []).map((item) => actionId("must", item)));
    for (const id of action?.dependsOnMust || []) {
      if (!active.has(id)) continue;
      const complete = context.state?.completed?.[id];
      const blocked = context.state?.blocked?.[id];
      const waiver = context.state?.waived?.[id];
      const resolved = (complete?.audit?.complete === true && complete?.verification?.status === "verified"
        && !["queued", "required"].includes(complete.refreshStatus))
        || blocked?.validation?.beforeDispatch === true
        || String(waiver?.reason || "").trim().length >= 10;
      if (!resolved) reasons.push({ code: "DEPENDENCY_UNRESOLVED", detail: id });
    }
    return { allowed: reasons.length === 0, reasons, inventory };
  }

  return { buildAssessment, actionId, resolveAction, snapshotScenario, evaluateEligibility };
});
