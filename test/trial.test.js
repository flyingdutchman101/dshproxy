const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { runTrial } = require("../src/backend/trial");

const API_KEY_MODELS = [{ id: "deepseek-chat", owned_by: "deepseek" }, { id: "qwen-max", owned_by: "qwen" }];
const ACCOUNT_MODELS = [{ id: "claude-haiku-5-5", owned_by: "anthropic" }, { id: "gpt-6-luna", owned_by: "openai" }];

// Stands in for the backend process: an HTTP server on the trial's port.
// `models(ms)` returns the model list `ms` milliseconds after the backend started.
function fakeBackend(models) {
  const seen = { probes: [] };
  let started = 0;
  const createBackend = ({ port }) => {
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.method === "GET" && request.url === "/v1/models") {
          response.end(JSON.stringify({ data: models(Date.now() - started) }));
        } else {
          seen.probes.push({ path: request.url, model: JSON.parse(body).model });
          response.end("{}");
        }
      });
    });
    return {
      start: () => new Promise((resolve) => server.listen(port, "127.0.0.1", () => { started = Date.now(); resolve(); })),
      stop: () => { server.closeAllConnections(); server.close(); }
    };
  };
  return { createBackend, seen };
}

function trial(t, backend, options = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-trial-test-"));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  return runTrial({ binary: "unused", authDir: workDir, workDir, accounts: new Set(["claude", "codex"]), createBackend: backend.createBackend, ...options });
}

test("the trial waits for the models of every signed-in service, not for the first model listed", async (t) => {
  // API-key models are listed at once; the accounts' models arrive later.
  const backend = fakeBackend((ms) => (ms < 600 ? API_KEY_MODELS : [...API_KEY_MODELS, ...ACCOUNT_MODELS]));
  const result = await trial(t, backend);
  assert.deepEqual(result.checks.slice(2), ["claude: claude-haiku-5-5 answered", "codex: gpt-6-luna answered"]);
  assert.equal(result.ok, true);
  assert.deepEqual(backend.seen.probes, [{ path: "/v1/messages", model: "claude-haiku-5-5" }, { path: "/v1/responses", model: "gpt-6-luna" }]);
});

test("a signed-in service whose models never appear still fails the trial, without a request to it", async (t) => {
  const backend = fakeBackend(() => [...API_KEY_MODELS, ACCOUNT_MODELS[1]]);
  const result = await trial(t, backend, { waitMs: 1200 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.slice(2), ["claude: no model of this service is listed", "codex: gpt-6-luna answered"]);
  assert.deepEqual(backend.seen.probes, [{ path: "/v1/responses", model: "gpt-6-luna" }]);
});

test("a service without its usual trial model is tried on another of its models, never an image model", async (t) => {
  const backend = fakeBackend(() => [{ id: "claude-image-1", owned_by: "anthropic" }, { id: "claude-other-1", owned_by: "anthropic" }, ACCOUNT_MODELS[1]]);
  const result = await trial(t, backend);
  assert.equal(result.ok, true);
  assert.equal(result.checks[2], "claude: claude-other-1 answered");
});
