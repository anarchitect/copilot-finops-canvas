---
agent: agent
description: Scan actual GitHub Copilot budgets and alerts without a canvas, plugin or installed skill.
---

Review GitHub Copilot budgets and alerts for enterprise ENTERPRISE on github.com, using authorised read only tools. Replace ENTERPRISE with my actual slug, or ask for it if missing. Default to a current UTC month inventory in this private chat. Ask only missing essential questions, one at a time. Do not infer the target from a repository or account membership.

This prompt is self contained. No skill, plugin, canvas or downloaded script is required. Use my existing authorised `gh` or approved REST tool; inspect its schema and effective identity safely. Never print/copy credentials, switch accounts, grant scopes or enable debug HTTP logging. Environment tokens can override stored gh accounts. Check the active identity and authentication state, not only the exit code. If tooling/authentication is missing or access is denied, explain the exact prerequisite or policy limit without bypassing it.

Before reading, verify routes, permissions, API version and field meanings in current official sources:
https://docs.github.com/en/enterprise-cloud@latest/rest/billing/budgets
https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage
https://docs.github.com/en/enterprise-cloud@latest/rest/billing/cost-centers
https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets
https://docs.github.com/en/copilot/tutorials/budgets/optimizing-your-budget-configuration
https://docs.github.com/en/billing/reference/cost-center-allocation
https://docs.github.com/en/billing/concepts/budgets-and-alerts

For enterprise inventory, start with this GET template after replacing the target. Use the verified current version if it has changed:

```powershell
gh api --method GET --hostname github.com "enterprises/ENTERPRISE/settings/billing/budgets?per_page=100&page=1" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2026-03-10" --include
```

Read the selected enterprise's `settings/billing/cost-centers?state=active` and `settings/billing/ai_credit/usage?year=YYYY&month=MM` with the same explicit GET and headers, replacing the period. Fetch paginated cost center detail only when assignment evidence is needed. If I selected only an organisation, verify and use `/organizations/{org}/settings/billing/budgets` and `/organizations/{org}/settings/billing/ai_credit/usage`, not personal usage or `/orgs/` billing routes. Do not expand to unrelated scopes.

For budgets and cost center detail, follow body `has_next_page`, stable counts and any supported next links. `gh api --paginate` alone is insufficient for body pagination. Retain every budget ID, type and SKU. Validate shapes and matching usage period/filters. Mark repeated IDs, changing totals, malformed/missing pagination evidence, truncation or a failed later page as partial; preserve earlier observations. Missing/forbidden/unsupported is unknown, not zero or no budgets. Complete visible pagination does not prove enterprise wide access. Rate limit safely, never retry through other credentials.

Return a table of observed budget ID/name or entity, scope, product/SKU/type, amount with currency/unit/period, expiry if returned, alert enabled state and recipient count, stop usage state, known consumption/headroom, and source request/time. Omitted fields stay unknown; do not invent display names. Keep recipient identities private. GitHub Docs describe thresholds of 75%, 90% and 100% and default recipients; those are not returned per-budget settings or proof of delivery. Empty additional recipients do not mean nobody is notified.

Keep licence charges, AI credits and money separate. Calculate only observed budget headroom from finite, nonnegative amounts with verified matching units, scope and period. Never treat nominal included credits as remaining balance, missing use as zero, or reported additional spend as a whole invoice. Check documented zero budget blocking separately. A monthly usage report is not automatically consumption since a budget was created.

Apply individual, then cost center user, then universal user budget precedence. Unknown specific controls must not fall through to a generous default. Unexpanded teams are unresolved, not unassigned; multiple licensing organisations need actual billing allocation. Distinguish per-user controls from aggregate metered budgets. Paid usage policy, included usage cap behaviour and enterprise exclusions remain unknown unless verified. Where enterprise/narrower coverage guidance conflicts, report the ambiguity instead of adding balances or promising a combined cap. Monitoring may be intentional; recommend a blocking change only as a proposal tied to my stated goal and verified behaviour.

Lead with findings and UTC scan time, then the table, per-source status/pages/coverage, top risks, exact unknowns and proposed owner/next decision. Cite current sources; separate settings, documented rules and proposals. No invented savings or forecast.

No POST/PATCH/PUT/DELETE, billing edits, report jobs, purchases, invitations, scheduled work or extra paid AI assessment. Save nothing unless I select a private local report path outside repositories and shared folders; never publish account data to commits, issues, PRs or gists. A login needs my action and permission review; use Chrome and copy any device code to the clipboard, never collect a token.

If I ask to open the native canvas, discover the actual plugin provider and open schema first. Open only an already enabled, ready, permitted provider for the confirmed target. Respect prompts; do not reload, change disable settings, copy extensions or dispatch Inventory/AI/actions. If unavailable, continue this scan in chat. Claim native success only when an instance is returned and its panel is visible, never from CLI listing or browser preview. This fallback provides similar analysis, not identical native execution.

End by stating what was inspected and that no GitHub settings changed. The linked GitHub Docs guidance is summarised from GitHub and contributors under https://creativecommons.org/licenses/by/4.0/; no runtime or article is bundled.
