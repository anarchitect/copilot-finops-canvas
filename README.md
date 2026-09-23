# Copilot FinOps canvas

Standalone plugin marketplace for the Copilot FinOps canvas.

## Scan without the canvas

The fallback reads your actual GitHub Copilot budgets, alert settings and available usage, then returns an evidence table and recommendations in private chat. It works when the canvas is unavailable or disabled. It does not install, enable or repair the canvas, and does not change GitHub settings.

You need the real enterprise slug and an existing authorised GitHub CLI (`gh`) account or approved REST tool with access to the requested billing scope. Copilot sign in alone does not grant that access. An organisation scan is also supported, but cannot establish enterprise wide coverage.

### Paste a prompt, no skill installation

Open [the standalone prompt](.github/prompts/copilot-finops-fallback.prompt.md). Copy everything below its YAML frontmatter (the second `---`) into a private Copilot App chat. Replace `ENTERPRISE` with your enterprise slug and send it. No plugin, downloaded script or repository checkout is needed to run the pasted prompt.

The `.prompt.md` location is standard for supported IDEs. Copilot App users should paste the text; do not depend on IDE prompt slash commands being available in the App.

### Reuse the skill

The skill is [`.github\skills\copilot-finops-fallback\SKILL.md`](.github/skills/copilot-finops-fallback/SKILL.md). Open this repository in Copilot App, or copy the `copilot-finops-fallback` folder into your personal skills directory. On Windows that is `%USERPROFILE%\.copilot\skills\copilot-finops-fallback\SKILL.md`. Review the file before installing it.

Check the App's **Customize > Skills** view. In an interactive Copilot CLI session, `/skills reload` and `/skills info copilot-finops-fallback` can confirm discovery. If the host does not discover the skill, paste the standalone prompt instead.

Run:

```text
Use /copilot-finops-fallback to scan enterprise ENTERPRISE. Keep the report in this private chat.
```

Replace `ENTERPRISE` with your own slug. The default is an inventory for the current UTC month, not a request to change budgets. For an organisation, say `scan organisation ORGANISATION` instead. To guide recommendations, add `My goal is monitoring` or `My goal is a hard spending cap`.

Results stay in chat unless you explicitly choose a private local Markdown path outside repository checkouts and shared folders. Do not save tenant reports in this public repository.

### Optional canvas

Add `Also open the native canvas if its plugin provider is already enabled and permitted`. The agent must inspect the provider and its open schema first. A disabled or missing provider does not block the chat scan and will not be enabled automatically.

The separate experimental canvas package has [tagged installation guidance](https://github.com/anarchitect/copilot-finops-canvas/tree/v1.0.0-experimental.1). The fallback does not depend on that package or reproduce its native interface, calculator or action system.

## Synthetic result example

All identifiers, settings and times below are fictional. This is an example of the report format, not a live scan.

Scan: `2026-09-24T00:00:00Z`. Target: `example-enterprise`. Goal: monitoring. Synthetic responses contain two budgets in two pages with a stable total of two. A fictional billing UI observation independently confirmed USD amounts and the current monthly cycle for `demo-1`; those meanings are not inferred from a retrieval timestamp.

| Budget ID / observed entity | Scope | Product / type | Limit and period | Alerts | Stop usage | Consumption / observed headroom | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `demo-1` / enterprise; no display name returned | `enterprise` | `ai_credits` / `BundlePricing` | USD 100, current monthly cycle | Enabled; zero additional recipients returned; delivery unverified | `false`, monitoring only | USD 30 / USD 70, for this budget only | Budget page 1, `budget_amount`, `consumed_amount`, `budget_alerting`, `prevent_further_usage`; fictional UI unit/period check |
| `demo-2` / `sample-person` | `user` | `ai_credits` / `BundlePricing` | USD 20 per month, documented interpretation | Disabled in returned record | `true`, user budget hard stop documented | Unknown / unknown | Budget page 2; `consumed_amount` absent |

The budget API does not return threshold percentages. The documented 75%, 90% and 100% alert thresholds are guidance, not independently observed settings. Zero additional recipients does not prove that default owners receive no alerts.

| Source | Status and coverage |
| --- | --- |
| Budgets | Two of two visible records retrieved; account wide visibility still unverified |
| Cost centers | Forbidden; assignments, included usage controls and exclusions unknown |
| AI credit usage | Not available; shared pool balance and additional spend unknown |
| Native canvas | Explicitly disabled; not opened or changed |

**Proposals:** Keep monitoring as the stated goal; have the billing owner confirm alert delivery. Resolve cost center visibility before assessing combined controls. Do not infer the individual's remaining allowance from the enterprise's USD 70 headroom.

Read only scan; no GitHub settings changed.

## Format and source guidance

See GitHub's [agent skills format](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills), [Copilot App customisation](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app) and [prompt file format and supported hosts](https://docs.github.com/en/copilot/tutorials/customization-library/prompt-files/your-first-prompt-file). The skill links to current billing sources and explains how to handle incomplete data and conflicting scope guidance.
