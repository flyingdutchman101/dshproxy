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

// Who the backend names as the owner of each account type's models.
const OWNERS = { claude: "anthropic", codex: "openai", antigravity: "antigravity", kimi: "moonshot" };

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
// `waitMs` is how long the accounts' models may take to appear;
// `createBackend` replaces the backend process in tests.
async function runTrial({ binary, authDir, workDir, accounts, providers = {}, log = () => {}, waitMs = 30000, createBackend = createSupervisor }) {
  fs.mkdirSync(workDir, { recursive: true });
  const port = await freePort();
  const configPath = path.join(workDir, "trial-config.yaml");
  fs.writeFileSync(configPath, render({ host: "127.0.0.1", port, authDir, providers }));
  const supervisor = createBackend({ binary, configPath, host: "127.0.0.1", port, log: (line) => log(`trial: ${line}`) });
  const checks = [];
  let ok = true;
  try {
    await supervisor.start({ timeoutMs: 45000 });
    checks.push("started and answered on a spare port");
    // The backend answers before it has loaded the accounts. API-key models
    // are listed at once and the accounts' models a few seconds later, so the
    // wait is for a model of every signed-in service, not for the first model.
    const probed = [...accounts].filter((account) => PROBES[account]);
    let listed = [];
    // The model to ask: the usual one, or else another of the same service, so
    // a plan without the usual model never blocks every future update.
    const modelFor = (account) => {
      if (listed.some((item) => item.id === PROBES[account].model)) return PROBES[account].model;
      const other = listed.find((item) => item.owned_by === OWNERS[account] && !/image|embed|tts/i.test(item.id));
      return other ? other.id : null;
    };
    const deadline = Date.now() + waitMs;
    for (;;) {
      const models = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(10000) }).then((response) => response.json()).catch(() => null);
      listed = Array.isArray(models?.data) ? models.data : [];
      if ((listed.length || !accounts.size) && probed.every(modelFor)) break;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    checks.push(`lists ${listed.length} models`);
    if (accounts.size && !listed.length) ok = false;
    for (const account of probed) {
      const probe = PROBES[account];
      const model = listed.length ? modelFor(account) : probe.model;
      if (!model) {
        checks.push(`${account}: no model of this service is listed`);
        ok = false;
        continue;
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
