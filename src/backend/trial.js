// Runs a new CLIProxyAPI version on a spare port, with the same accounts and
// API keys, and asks it to answer one small request per signed-in service.
// The running backend is not touched.

const fs = require("fs");
const net = require("net");
const path = require("path");
const { render } = require("./config");
const { createSupervisor } = require("./supervisor");

// One cheap model per account type, asked for a one-word answer.
const PROBES = {
  claude: { model: "claude-haiku-5-5", path: "/v1/messages", headers: { "anthropic-version": "2023-06-01", "x-api-key": "trial" }, body: (model) => ({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with one word: ok" }] }) },
  codex: { model: "gpt-6-luna", path: "/v1/responses", headers: { authorization: "Bearer trial" }, body: (model) => ({ model, max_output_tokens: 16, input: [{ role: "user", content: "Reply with one word: ok" }] }) },
  antigravity: { model: "gemini-3.8-flash-high", path: "/v1/chat/completions", headers: { authorization: "Bearer trial" }, body: (model) => ({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with one word: ok" }] }) },
  kimi: { model: "kimi-k3", path: "/v1/chat/completions", headers: { authorization: "Bearer trial" }, body: (model) => ({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with one word: ok" }] }) }
};

// Statuses that say the account is out of quota or busy rather than that the
// new version is broken.
const QUOTA = new Set([402, 429, 529]);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// `accounts` are the signed-in account types (a Set); `providers` the readable
// API keys, as for the real backend.
//
// The trial uses the real auth folder, not a copy. If it refreshes a token it
// writes the file, and the running backend's folder watcher reloads it. A copy
// would be worse: providers that rotate refresh tokens would then invalidate
// the token the running backend still holds.
async function runTrial({ binary, authDir, workDir, accounts, providers = {}, log = () => {} }) {
  fs.mkdirSync(workDir, { recursive: true });
  const port = await freePort();
  const configPath = path.join(workDir, "trial-config.yaml");
  fs.writeFileSync(configPath, render({ host: "127.0.0.1", port, authDir, providers }));
  const supervisor = createSupervisor({ binary, configPath, host: "127.0.0.1", port, log: (line) => log(`trial: ${line}`) });
  const checks = [];
  let ok = true;
  try {
    await supervisor.start({ timeoutMs: 45000 });
    checks.push("started and answered on a spare port");
    // The backend answers before it has loaded the accounts; their models
    // appear a few seconds later.
    let served = new Set();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const models = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(10000) }).then((response) => response.json()).catch(() => null);
      served = new Set((models?.data || []).map((item) => item.id));
      if (served.size || !accounts.size) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    checks.push(`lists ${served.size} models`);
    if (accounts.size && !served.size) ok = false;
    for (const account of accounts) {
      const probe = PROBES[account];
      if (!probe) continue;
      // A plan without the usual probe model is tried on another model of the
      // same service, so one missing model never blocks every future update.
      let model = probe.model;
      if (served.size && !served.has(model)) {
        const owner = { claude: "anthropic", codex: "openai", antigravity: "antigravity", kimi: "moonshot" }[account];
        const listed = (await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json()).catch(() => ({ data: [] }))).data || [];
        const fallback = listed.find((item) => item.owned_by === owner && !/image|embed|tts/i.test(item.id));
        if (!fallback) {
          checks.push(`${account}: no model of this service is listed`);
          ok = false;
          continue;
        }
        model = fallback.id;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}${probe.path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...probe.headers },
          body: JSON.stringify(probe.body(model)),
          signal: AbortSignal.timeout(90000)
        });
        const text = (await response.text()).replace(/\s+/g, " ").slice(0, 160);
        if (response.ok) checks.push(`${account}: ${model} answered`);
        else if (QUOTA.has(response.status)) checks.push(`${account}: ${model} is out of quota (HTTP ${response.status}); not counted against the update`);
        else {
          checks.push(`${account}: ${model} failed with HTTP ${response.status}: ${text}`);
          ok = false;
        }
      } catch (error) {
        checks.push(`${account}: ${model} did not answer (${error.message})`);
        ok = false;
      }
    }
  } catch (error) {
    checks.push(`did not start: ${error.message}`);
    ok = false;
  } finally {
    supervisor.stop();
    fs.rmSync(configPath, { force: true });
  }
  return { ok, checks };
}

module.exports = { runTrial, PROBES };
