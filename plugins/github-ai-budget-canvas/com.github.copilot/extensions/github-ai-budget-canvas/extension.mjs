import { createReadiness } from "./lib/readiness.mjs";
import { createStateStore, safeEnterpriseName } from "./lib/state-store.mjs";
import { createOperations } from "./lib/operations.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const rendererRoot = join(extensionRoot, "renderer");
const servers = new Map();
const instanceConfig = new Map();


const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

const testMode = process.env.COPILOT_FINOPS_TEST_MODE === "1";
const sdk = testMode ? null : await import("@github/copilot-sdk/extension");
const session = testMode
  ? globalThis.__COPILOT_FINOPS_TEST_SESSION
  : await sdk.joinSession(createRegistration(sdk));

export function createRegistration(sdk) {
  const action = (name, method, description, properties = {}) => ({
    name, description,
    inputSchema: { type: "object", properties, additionalProperties: false },
    handler: async (ctx) => operations[method](getContext(ctx.instanceId), ctx.input || {})
  });
  const selection = { type: "object", properties: {
    paidUsage: { type: "boolean" },
    budgetObjective: { type: "string", enum: ["unknown", "monitor", "hard_cap"] },
    costCenterName: { type: "string" }
  }, additionalProperties: false };
  const revision = { type: "integer", minimum: 0 };
  return {
  requestedEnvironmentVariables: ["GH_TOKEN", "GITHUB_TOKEN"],
  canvases: [
    sdk.createCanvas({
      id: "github-ai-budget-canvas",
      displayName: "Copilot FinOps canvas",
      description: "Calculate GitHub AI budget precedence and send live inventory or AI assessment requests to the active chat agent.",
      inputSchema: {
        type: "object",
        properties: {
          enterprise: {
            type: "string",
            minLength: 1,
            description: "GitHub enterprise slug to assess."
          },
          credentialMode: {
            type: "string",
            enum: ["auto", "environment", "gh"],
            description: "Use granted environment credentials, stored GitHub CLI credentials, or automatic precedence."
          }
        },
        required: ["enterprise"],
        additionalProperties: false
      },
      actions: [
        action("request_inventory", "inventory", "Request read-only inventory through the shared service."),
        action("request_ai_assessment", "assessment", "Request a read-only assessment in chat."),
        action("get_action_state", "state", "Read saved outcomes and recovery state."),
        action("get_readiness", "inspect", "Inspect the selected actor and read capabilities."),
        action("prepare_action", "prepare", "Prepare a current recommendation without changing GitHub.",
          { id: { type: "string" }, scenario: selection, expectedRevision: revision }),
        action("proceed_action", "proceed", "Request native confirmation for an exact saved operation.",
          { operationId: { type: "string" }, expectedRevision: revision }),
        action("reconcile_action", "reconcile", "Reconcile a saved outcome using read-only evidence, never a replay.",
          { operationId: { type: "string" } }),
        action("waive_action", "waive", "Record a reasoned local Must waiver, not completion.",
          { id: { type: "string" }, reason: { type: "string" }, scenario: selection, expectedRevision: revision })
      ],
      open: async (ctx) => {
        const enterprise = safeEnterpriseName(ctx.input?.enterprise);
        const credentialMode = ctx.input?.credentialMode ?? "auto";
        if (!["auto", "environment", "gh"].includes(credentialMode)) {
          throw Object.assign(new Error("Select auto, environment or gh credentials."), { code: "INVALID_CREDENTIAL_MODE" });
        }
        const existing = instanceConfig.get(ctx.instanceId);
        if (existing && (existing.enterprise !== enterprise || existing.credentialMode !== credentialMode)) {
          throw Object.assign(new Error("This panel's context is fixed. Open a new instance for another enterprise or credential selection."),
            { code: "INSTANCE_CONTEXT_IMMUTABLE" });
        }
        let pending = servers.get(ctx.instanceId);
        if (!pending) {
          instanceConfig.set(ctx.instanceId, Object.freeze({ enterprise, credentialMode }));
          pending = startServer(enterprise, credentialMode);
          servers.set(ctx.instanceId, pending);
        }
        let entry;
        try {
          entry = await pending;
        } catch (error) {
          if (servers.get(ctx.instanceId) === pending) {
            servers.delete(ctx.instanceId);
            instanceConfig.delete(ctx.instanceId);
          }
          throw error;
        }
        return {
          title: "Copilot FinOps canvas",
          url: entry.url,
          status: "Readiness not checked"
        };
      },
      onClose: async (ctx) => {
        const pending = servers.get(ctx.instanceId);
        instanceConfig.delete(ctx.instanceId);
        if (!pending) return;
        servers.delete(ctx.instanceId);
        const entry = await pending;
        await new Promise((resolveClose) => entry.server.close(resolveClose));
      }
    })
  ]
  };
}

if (testMode && !session) {
  throw new Error("COPILOT_FINOPS_TEST_MODE requires __COPILOT_FINOPS_TEST_SESSION.");
}

const store = createStateStore({ workspacePath: session.workspacePath });
const testAdapters = testMode ? globalThis.__COPILOT_FINOPS_TEST_ADAPTERS || {} : {};
const readiness = createReadiness(testMode ? {
  env: {},
  runProcess: async () => { throw new Error("No external process adapter supplied by this synthetic test."); },
  ...testAdapters
} : {});
const { inventorySnapshotPath, readSnapshot: loadLiveSnapshot, loadActionState } = store;
const operations = createOperations({
  session, store, readiness, inventoryPrompt
});

function getContext(instanceId) {
  const context = instanceConfig.get(instanceId);
  if (!context) throw Object.assign(new Error("Open this canvas instance first."), { code: "INVALID_INPUT" });
  return context;
}

function inventoryPrompt(enterprise, outputPath, reason = "") {
  return [
    reason,
    `Inventory the current GitHub Copilot AI budget configuration for enterprise '${enterprise}'.`,
    "Use GitHub CLI and REST APIs, not admin UI navigation.",
    "If API access is unavailable, report the gap. Do not assume an installed browser is an authenticated automation driver.",
    "Run read-only gh api calls for enterprise budgets, cost centers, enterprise teams, team membership, Copilot seats, and AI credit usage.",
    `Use endpoints under enterprises/${enterprise}.`,
    "Download these Markdown sources again:",
    "https://docs.github.com/api/article/body?pathname=/en/enterprise-cloud@latest/copilot/concepts/billing-and-usage/organizations-and-enterprises/budgets",
    "https://docs.github.com/api/article/body?pathname=/en/copilot/tutorials/budgets/optimizing-your-budget-configuration",
    `Write the completed snapshot to '${outputPath}' as a JavaScript assignment named window.GITHUB_BILLING_SNAPSHOT.`,
    "Use schemaVersion 2, source 'gh-api', the exact enterprise slug, an ISO generatedAt value, arrays named budgets, costCenters, and enterpriseTeams, plus copilotSeats and aiCreditUsage when available.",
    "Preserve every returned budget ID, pricing type and SKU. Keep unknown amounts, enforcement, assignments and consumption unavailable, never zero by default.",
    "Retain the AI credit usage response timePeriod and the exact request filters. Do not infer the billing period or full visibility from generatedAt or successful pagination.",
    "Do not claim complete budget or assignment visibility from this agent-written snapshot; the canvas treats the returned collection as visible observations only.",
    "Write only to that session workspace file. Do not overwrite committed renderer assets.",
    "Do not change GitHub settings. Report the inventory result, permissions failures, and exact files updated in this chat."
  ].filter(Boolean).join(" ");
}

async function startServer(enterprise, credentialMode = "auto", service = operations) {
  safeEnterpriseName(enterprise);
  const context = { enterprise, credentialMode };
  const routes = {
    "GET /api/action-state": "state", "GET /api/prerequisites": "inspect",
    "POST /api/inventory": "inventory", "POST /api/ai-assessment": "assessment",
    "POST /api/prepare": "prepare", "POST /api/proceed": "proceed",
    "POST /api/reconcile": "reconcile", "POST /api/waive": "waive"
  };
  const server = createServer(async (request, response) => {
    try {
      const method = routes[`${request.method} ${request.url}`];
      if (method) {
        const input = request.method === "POST" ? await readJsonBody(request) : undefined;
        const result = await service[method](context, input);
        sendJson(response, ["queued", "awaiting-approval", "running"].includes(result.status) ? 202 : 200, { ok: true, ...result });
        return;
      }
      if (request.method === "GET") {
        await serveStatic(request, response, enterprise, credentialMode, service);
        return;
      }
      sendJson(response, 405, { ok: false, error: "Method not allowed." });
    } catch (error) {
      const code = error.code || "INTERNAL_ERROR";
      const status = /^INVALID_/.test(code) ? 400 : code === "READINESS_UNVERIFIED" ? 403
        : /CONFLICT|STALE|CHANGED|UNRESOLVED|OUTCOME_UNKNOWN/.test(code) ? 409 : 500;
      sendJson(response, status, {
        ok: false,
        errorCode: code,
        error: error.code ? error.message : "The canvas operation failed. No successful outcome is assumed."
      });
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => { server.off("error", rejectListen); resolveListen(); });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error("Request body is too large."), { code: "INVALID_INPUT" });
    chunks.push(chunk);
  }
  try {
    const text = Buffer.concat(chunks).toString("utf8");
    const value = text ? JSON.parse(text) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid shape");
    return value;
  } catch {
    throw Object.assign(new Error("Supply a valid JSON object."), { code: "INVALID_INPUT" });
  }
}

async function serveStatic(request, response, enterprise, credentialMode = "auto", service = operations) {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (pathname === "/config.js") {
    const content = `window.CANVAS_CONFIG = ${JSON.stringify({ enterprise, credentialMode })};\n`;
    response.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Content-Length": Buffer.byteLength(content),
      "Cache-Control": "no-store"
    });
    response.end(content);
    return;
  }
  if (pathname === "/data/current-settings.js") {
    const { snapshot } = await service.state({ enterprise, credentialMode });
    if (snapshot) {
      const source = `window.GITHUB_BILLING_SNAPSHOT = ${JSON.stringify(snapshot)};\n`;
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": Buffer.byteLength(source),
        "Cache-Control": "no-store"
      });
      response.end(source);
      return;
    }
  }
  const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(join(rendererRoot, requestedPath));
  const relativePath = relative(rendererRoot, filePath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    sendJson(response, 403, { ok: false, error: "Path is outside the renderer root." });
    return;
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
      "Content-Length": content.length,
      "Cache-Control": "no-store"
    });
    response.end(content);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    sendJson(response, 404, { ok: false, error: "File not found." });
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

export {
  inventorySnapshotPath,
  loadLiveSnapshot,
  operations,
  safeEnterpriseName,
  serveStatic,
  startServer
};
