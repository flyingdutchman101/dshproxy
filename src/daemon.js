// Starts the backend and the gateway and keeps them running.

const fs = require("fs");
const accounts = require("./accounts");
const app = require("./app");
const { render } = require("./backend/config");
const { install } = require("./backend/install");
const { createSupervisor } = require("./backend/supervisor");
const { createFailover } = require("./gateway/failover");
const { createGateway } = require("./gateway/server");
const { createSessions } = require("./gateway/sessions");
const { createResolver, describe, availability } = require("./lanes");
const profile = require("./dsh/profile");

const ACCOUNT_CACHE_MS = 5000;

async function start({ home, print = console.log } = {}) {
  const state = await app.snapshot(home);
  const { settings, paths } = state;
  const log = (line) => {
    app.appendLog(paths.log, line);
    print(line);
  };

  const backend = await install(app.lock, paths.binDir, { log });
  fs.mkdirSync(state.authDir, { recursive: true });
  fs.writeFileSync(paths.config, render({ host: settings.host, port: settings.backendPort, authDir: state.authDir, requestRetry: settings.requestRetry, providers: state.readable }));
  if (state.unreadable.length) log(`Saved API key cannot be read for: ${state.unreadable.join(", ")}. Enter it again with \`dshgate key set\`.`);

  const supervisor = createSupervisor({ binary: backend.path, configPath: paths.config, host: settings.host, port: settings.backendPort, pidFile: paths.backendPid, log });
  await supervisor.start();

  // Accounts can be added while the gateway runs, so they are re-read, but not
  // on every request.
  let cached = { at: 0, active: state.activeAccounts };
  const activeAccounts = () => {
    if (Date.now() - cached.at > ACCOUNT_CACHE_MS) cached = { at: Date.now(), active: accounts.activeProviders(state.authDir) };
    return cached.active;
  };
  const isAvailable = (model) => availability({ accounts: activeAccounts(), providers: state.readable })(model);

  const failover = createFailover({ cooldownMs: settings.cooldownMinutes * 60 * 1000, threshold: settings.failureThreshold });
  const startedAt = new Date().toISOString();
  const status = () => ({
    version: app.version,
    startedAt,
    origin: state.origin,
    backend: { name: app.lock.name, version: app.lock.version, port: settings.backendPort, ...supervisor.state() },
    lanes: Object.entries(settings.lanes).map(([name, ladder]) => ({
      name,
      ladder: ladder.map((model) => ({ model, available: isAvailable(model), coolingUntil: failover.coolingUntil(model)?.toISOString() ?? null }))
    })),
    accounts: accounts.list(state.authDir).map(({ provider, account, disabled }) => ({ provider, account, disabled })),
    apiKeys: { readable: Object.keys(state.readable), unreadable: state.unreadable },
    deepseekHarness: { applied: profile.state(state.origin).applied }
  });

  const gateway = createGateway({
    upstream: { host: settings.host, port: settings.backendPort },
    resolve: createResolver({ lanes: () => settings.lanes, isAvailable }),
    describe,
    failover,
    sessions: createSessions(),
    log,
    status
  });

  try {
    await new Promise((resolve, reject) => {
      gateway.once("error", (error) => reject(new Error(error.code === "EADDRINUSE" ? `Port ${settings.port} is already in use. Stop the program using it or change "port" in settings.json.` : error.message)));
      gateway.listen(settings.port, settings.host, resolve);
    });
  } catch (error) {
    supervisor.stop();
    throw error;
  }
  log(`dshgate ${app.version} listening on ${state.origin} (backend ${app.lock.name} ${app.lock.version} on port ${settings.backendPort})`);

  const stop = () => {
    gateway.close();
    gateway.closeAllConnections();
    supervisor.stop();
  };
  return { origin: state.origin, status, stop };
}

module.exports = { start };
