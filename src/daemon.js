// Starts the backend and the gateway and keeps them running.

const crypto = require("crypto");
const fs = require("fs");
const accounts = require("./accounts");
const app = require("./app");
const { render } = require("./backend/config");
const { install } = require("./backend/install");
const { createManagement } = require("./backend/management");
const { createSupervisor } = require("./backend/supervisor");
const { PREFIX: CONTROL_PREFIX, createControl, newToken, writeToken } = require("./control");
const { createFailover } = require("./gateway/failover");
const { createGateway, STATUS_PATH } = require("./gateway/server");
const { createSessions } = require("./gateway/sessions");
const { createResolver, describe, availability } = require("./lanes");
const { createLimits } = require("./limits");
const { createAccountOrder } = require("./primary");
const { createLogins } = require("./login");
const catalog = require("./catalog");
const profile = require("./dsh/profile");
const { fetchCatalog } = require("./models");
const { checkForUpdate, createUpdater } = require("./backend/updater");
const { runTrial } = require("./backend/trial");
const settingsFile = require("./settings");
const presets = require("./presets");

const ACCOUNT_CACHE_MS = 5000;
// The model catalog and the backend's model list are refreshed this often.
const DISCOVERY_MS = 3 * 60 * 60 * 1000;
// GitHub is asked for a newer backend this often.
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
// How long a stop waits for a moment with nothing in flight when it is not
// told, and the longest wait the control interface accepts.
const IDLE_WAIT_SECONDS = 300;
const MAX_IDLE_WAIT_SECONDS = 24 * 60 * 60;
// The longest delay a timer can hold.
const MAX_TIMER_MS = 2 ** 31 - 1;

// Counts the requests in flight on an HTTP server: those for which
// `counted(req)` holds, from the moment their head has been read until their
// answer has ended. `ended(count)` is called each time one ends.
//
// The count rises in the server's "request" event itself, before the handler
// has done anything, so a request the server has taken is never missed. It
// falls when the response closes or the connection does, whichever comes
// first: a response that ends normally, a client that goes away, a backend
// that fails and a connection that is destroyed all end in one of the two. A
// request waiting behind another on the same connection has no response
// stream of its own yet, so only the connection tells when it is over.
function countRequests(server, counted, ended) {
  let count = 0;
  server.prependListener("request", (req, res) => {
    const socket = req.socket;
    if (!counted(req) || !socket || socket.closed) return;
    count += 1;
    let over = false;
    const end = () => {
      if (over) return;
      over = true;
      res.removeListener("close", end);
      socket.removeListener("close", end);
      count -= 1;
      ended(count);
    };
    res.once("close", end);
    socket.once("close", end);
  });
  return () => count;
}

// The model IDs and figures DeepSeek Harness is given, for comparing two lists.
function fingerprint(models) {
  return JSON.stringify(models.map((model) => [model.id, model.api, model.contextWindow, model.maxTokens, model.efforts, model.input]).sort());
}

// `restart()` stops this gateway and starts it again (on the backend version
// now in the lock file). The Windows app and the CLI supply it.
// `exit()` ends the process; it is called once, after a stop that was asked
// for over the control interface has been answered.
// `backend` replaces how the backend program is installed and run. Only tests
// supply it: they must never download or start the real program.
async function start({ home, print = console.log, restart = null, exit = null, backend: backendProgram = {} } = {}) {
  const installBackend = backendProgram.install || install;
  const superviseBackend = backendProgram.createSupervisor || createSupervisor;
  let state = await app.snapshot(home);
  const { settings, paths } = state;
  const log = (line) => {
    app.appendLog(paths.log, line);
    print(line);
  };
  const lock = app.currentLock(state.home);

  const backend = await installBackend(lock, paths.binDir, { log });
  fs.mkdirSync(state.authDir, { recursive: true });
  // A new Management API key every start. Only this process knows it; the
  // backend stores a hash of it.
  const managementKey = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(paths.config, render({ host: settings.host, port: settings.backendPort, authDir: state.authDir, providers: state.readable, custom: state.custom, managementKey }));
  if (state.unreadable.length) log(`Saved API key cannot be read for: ${state.unreadable.join(", ")}. Enter it again with \`dshproxy key set\`.`);

  const supervisor = superviseBackend({ binary: backend.path, configPath: paths.config, host: settings.host, port: settings.backendPort, pidFile: paths.backendPid, log });
  await supervisor.start();

  // Accounts can be added while the gateway runs, so they are re-read, but not
  // on every request.
  let cached = { at: 0, active: state.activeAccounts };
  const activeAccounts = () => {
    if (Date.now() - cached.at > ACCOUNT_CACHE_MS) cached = { at: Date.now(), active: accounts.activeProviders(state.authDir) };
    return cached.active;
  };
  // Subscription models come from the latest discovery; API-key models from
  // the saved keys. Re-read when the model list or the accounts change.
  let offered = { isAvailable: state.isAvailable, at: Date.now() };
  let imageCache = { at: 0, map: new Map() };
  const imageModels = () => {
    if (Date.now() - imageCache.at > ACCOUNT_CACHE_MS) {
      try {
        const offered = app.offeredModels(settings, activeAccounts(), state.readable, app.readDiscovery(state.home));
        imageCache = { at: Date.now(), map: new Map(offered.models.map((m) => [m.id, !Array.isArray(m.input) || m.input.length === 0 || m.input.includes("image")])) };
      } catch {
        imageCache = { at: Date.now(), map: new Map() };
      }
    }
    return imageCache.map;
  };
  const isAvailable = (model) => {
    if (Date.now() - offered.at > ACCOUNT_CACHE_MS) {
      const discovery = app.readDiscovery(state.home);
      offered = { isAvailable: app.offeredModels(settings, activeAccounts(), state.readable, discovery).isAvailable, at: Date.now() };
    }
    return offered.isAvailable(model) || availability({ accounts: activeAccounts(), providers: state.readable })(model);
  };


  // Which account serves which model, so a lane can skip an account that is
  // rate-limiting instead of walking all of its models.
  let accountCache = { at: 0, accounts: new Map() };
  const accountOf = (model) => {
    if (Date.now() - accountCache.at > ACCOUNT_CACHE_MS) {
      try {
        const list = app.offeredModels(settings, activeAccounts(), state.readable, app.readDiscovery(state.home)).models;
        accountCache = { at: Date.now(), accounts: new Map(list.filter((item) => item.account).map((item) => [item.id, item.account])) };
      } catch {
        accountCache = { at: Date.now(), accounts: new Map() };
      }
    }
    return accountCache.accounts.get(model) || null;
  };

  // ---- Model discovery: the catalog plus what the backend serves ----
  let discoveryError = null;
  // Fetches the catalog and served list, then syncs, as one queued step.
  const discover = () => serial(async () => {
    await fetchDiscovery();
    return syncNow("model list changed");
  });
  async function fetchDiscovery() {
    const saved = app.readDiscovery(state.home);
    let catalogJson = saved.catalog;
    let catalogError = null;
    try {
      catalogJson = await fetchCatalog();
    } catch (error) {
      catalogError = error.message;
    }
    let served = saved.served;
    try {
      const response = await fetch(`http://${settings.host}:${settings.backendPort}/v1/models`, { signal: AbortSignal.timeout(15000) });
      if (response.ok) served = (await response.json()).data || served;
    } catch {
      // keep the last list
    }
    app.saveDiscovery(state.home, { catalog: catalogJson, served, fetchedAt: new Date().toISOString(), catalogError });
    discoveryError = catalogError;
    offered.at = 0;
  }

  // Re-applies the DeepSeek Harness routes when the offered models change, if
  // DSHProxy's routes are already there. Each profile is backed up first.
  // Discovery and syncs run one at a time, so an older snapshot can never be
  // written after a newer one.
  let queue = Promise.resolve();
  const serial = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  let lastFingerprint = null;
  let harnessNote = null;
  const syncHarness = (reason) => serial(() => syncNow(reason));
  async function syncNow(reason) {
    state = await app.snapshot(state.home);
    const print2 = fingerprint(state.models);
    if (print2 === lastFingerprint) return { changed: false };
    const first = lastFingerprint === null;
    try {
      // Only profiles that already have DSHProxy routes are written.
      const result = profile.apply(state.models, state.origin, profile.dshHome(), { keepModelPrefixes: state.unreadable, onlyApplied: true });
      lastFingerprint = print2;
      const changed = result.profiles.filter((item) => item.changed).map((item) => item.profile);
      if (changed.length) {
        harnessNote = { at: new Date().toISOString(), profiles: changed, reason: first ? "models updated" : reason };
        log(`DeepSeek Harness routes updated (${changed.join(", ")}): ${first ? "models updated" : reason}. Restart DeepSeek Harness to see them.`);
      }
      return { changed: changed.length > 0 };
    } catch (error) {
      log(`DeepSeek Harness routes not updated: ${error.message}`);
      return { changed: false, error: error.message };
    }
  }

  // ---- Backend updates ----
  let update = null;
  async function checkUpdate() {
    try {
      const result = await checkForUpdate(app.currentLock(state.home));
      update = { ...result, checkedAt: new Date().toISOString(), error: null };
      if (result.available) log(`CLIProxyAPI ${result.latest} is available (running ${result.current}).`);
    } catch (error) {
      update = { available: false, checkedAt: new Date().toISOString(), error: error.message };
    }
    return update;
  }
  const updater = createUpdater({
    lockFile: app.writableLockFile(state.home),
    binDir: paths.binDir,
    install: (next, binDir) => install(next, binDir, { log }),
    trial: (binary) => runTrial({ binary, authDir: state.authDir, workDir: state.home, accounts: activeAccounts(), providers: state.readable, log }),
    restart: restart ? async () => { setTimeout(() => restart(), 200); } : null,
    current: () => app.currentLock(state.home),
    floor: app.shippedLock().version,
    log
  });

  const failover = createFailover({ cooldownMs: settings.cooldownMinutes * 60 * 1000, threshold: settings.failureThreshold });
  const startedAt = new Date().toISOString();
  // Requests in flight; set once the gateway exists.
  let inFlight = () => 0;
  const status = () => ({
    version: app.version,
    startedAt,
    origin: state.origin,
    inFlight: inFlight(),
    backend: { name: lock.name, version: lock.version, port: settings.backendPort, ...supervisor.state() },
    routing: presets.describe(settings.lanes),
    update,
    discovery: { error: discoveryError, harness: harnessNote },
    lanes: Object.entries(settings.lanes).map(([name, ladder]) => ({
      name,
      ladder: ladder.map((model) => ({ model, available: isAvailable(model), coolingUntil: failover.coolingUntil(model)?.toISOString() ?? null }))
    })),
    accounts: accounts.list(state.authDir).map(({ file, provider, account, disabled }) => ({ provider, account, disabled, primary: settings.primary[provider] === file })),
    apiKeys: { readable: Object.keys(state.readable), unreadable: state.unreadable },
    deepseekHarness: { applied: profile.state(state.origin).applied }
  });

  const management = createManagement({ host: settings.host, port: settings.backendPort, key: managementKey });
  const logins = createLogins({ management, log });
  const limits = createLimits({
    management,
    detailsFor: (file) => accounts.details(state.authDir, file),
    wantedModels: new Set(catalog.SUBSCRIPTION_MODELS.filter((model) => model.account === "antigravity").map((model) => model.upstream || model.id))
  });
  const accountFile = (file) => {
    const found = accounts.list(state.authDir).find((account) => account.file === file);
    if (!found) throw new Error("That account is not signed in.");
    return found;
  };
  // The accounts changed (signed in or out, paused, resumed, limit reset):
  // what was learned about which model is out of quota no longer holds.
  const afterChange = () => {
    cached = { at: 0, active: cached.active };
    limits.clear();
    failover.clear();
    // A signed-out account's file is gone, and one signed in again is new:
    // every account is told its place afresh. The backend needs a moment to
    // load a changed account first.
    order.forget();
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => order.refresh(), 2000);
  };

  // Tells the backend in which order to use a provider's accounts, and keeps
  // that in step with the usage report (see primary.js).
  const order = createAccountOrder({
    management,
    limits,
    listAccounts: () => accounts.list(state.authDir),
    primary: () => settings.primary,
    log
  });
  let changeTimer = null;
  const controlToken = newToken();
  writeToken(paths.controlToken, controlToken);
  const control = createControl({
    token: controlToken,
    routes: {
      "POST login/start": ({ provider }) => logins.start(String(provider || "")),
      "GET login/status": (_body, { id }) => logins.status(String(id || "")).then((result) => {
        if (result.status === "ok") afterChange();
        return result;
      }),
      "POST login/cancel": ({ id }) => logins.cancel(String(id || "")).then((cancelled) => ({ cancelled })),
      "GET limits": async (_body, { refresh }) => {
        const report = await limits.read({ accounts: accounts.list(state.authDir), force: refresh === "1" });
        // `siblings` is how many accounts the provider has, so the app offers
        // "Make primary" only where there is a choice.
        const count = (provider) => report.accounts.filter((entry) => entry.provider === provider).length;
        return { ...report, accounts: report.accounts.map((entry) => ({ ...entry, primary: settings.primary[entry.provider] === entry.file, siblings: count(entry.provider) })) };
      },
      "GET limits/raw": (_body, { file }) => limits.raw({ accounts: accounts.list(state.authDir), file: String(file || "") }),
      "GET resets": (_body, { file }) => limits.listResets({ accounts: accounts.list(state.authDir), file: String(file || "") }),
      "POST resets/use": async ({ file, creditId, requestId }) => {
        const result = await limits.useReset({ accounts: accounts.list(state.authDir), file: String(file || ""), creditId: creditId ? String(creditId) : null, requestId: String(requestId || "") });
        log(`limit reset for ${String(file || "")}: ${result.message}`);
        if (result.code === "reset") afterChange();
        return result;
      },
      "POST accounts/remove": async ({ file }) => {
        const account = accountFile(String(file || ""));
        await management.deleteCredential(account.file);
        afterChange();
        log(`signed out of ${account.label} (${account.account})`);
        return { removed: account.file };
      },
      "POST accounts/disable": async ({ file, disabled }) => {
        const account = accountFile(String(file || ""));
        await management.setDisabled(account.file, Boolean(disabled));
        afterChange();
        log(`${disabled ? "paused" : "resumed"} ${account.label} (${account.account})`);
        return { file: account.file, disabled: Boolean(disabled) };
      },
      // Makes one account the provider's primary (`primary: false` takes the
      // choice back, so the provider's accounts are equal again).
      "POST accounts/primary": async ({ file, primary }) => {
        const account = accountFile(String(file || ""));
        const current = settingsFile.load(state.home);
        if (primary === false) delete current.primary[account.provider];
        else current.primary[account.provider] = account.file;
        settingsFile.save(current, state.home);
        settings.primary = current.primary;
        const result = await order.apply();
        if (result.failed.length) throw new Error(`The backend did not accept the change: ${result.failed[0].error}`);
        log(primary === false ? `${account.label} has no primary account now` : `${account.label} (${account.account}) is the primary account`);
        return { provider: account.provider, primary: settings.primary[account.provider] || null };
      },
      "POST models/refresh": async () => {
        const result = await discover();
        return { ok: true, catalogError: discoveryError, harnessChanged: Boolean(result.changed) };
      },
      // Switches a model on or off for DeepSeek Harness.
      "POST models/choose": async ({ id, offered: on }) => {
        const modelId = String(id || "");
        if (!/^[A-Za-z0-9._:/-]{1,80}$/.test(modelId)) throw new Error("Not a model ID.");
        const current = settingsFile.load(state.home);
        const extra = new Set(current.models.extra);
        const hidden = new Set(current.models.hidden);
        if (on) {
          hidden.delete(modelId);
          extra.add(modelId);
        } else {
          extra.delete(modelId);
          hidden.add(modelId);
        }
        current.models = { extra: [...extra], hidden: [...hidden] };
        settingsFile.save(current, state.home);
        Object.assign(settings.models, current.models);
        offered.at = 0;
        const result = await syncHarness(`${modelId} switched ${on ? "on" : "off"}`);
        return { ok: true, harnessChanged: Boolean(result.changed) };
      },
      // Puts a newer model on a lane in place of an older one.
      "POST lanes/replace": async ({ from, to, lanes: names }) => {
        const current = settingsFile.load(state.home);
        const changed = [];
        for (const name of Array.isArray(names) ? names : []) {
          const ladder = current.lanes[name];
          if (!ladder || !ladder.includes(String(from))) continue;
          current.lanes[name] = ladder.map((model) => (model === String(from) ? String(to) : model)).filter((model, index, all) => all.indexOf(model) === index);
          changed.push(name);
        }
        if (!changed.length) throw new Error("Nothing to change.");
        settingsFile.save(current, state.home);
        Object.assign(settings.lanes, current.lanes);
        offered.at = 0;
        log(`lanes ${changed.join(", ")}: ${from} replaced by ${to}`);
        await syncHarness("lanes changed");
        return { ok: true, lanes: changed };
      },
      // Switches every lane to a routing preset (performance / balanced / cheap).
      "POST lanes/preset": async ({ name }) => {
        const preset = presets.get(String(name || ""));
        const current = settingsFile.load(state.home);
        // Copied so later edits cannot change the preset table.
        current.lanes = JSON.parse(JSON.stringify(preset.lanes));
        settingsFile.save(current, state.home);
        settings.lanes = current.lanes;
        offered.at = 0;
        log(`routing preset: ${preset.label}`);
        const result = await syncHarness(`routing preset ${preset.label}`);
        return { ok: true, preset: presets.describe(current.lanes), harnessChanged: Boolean(result.changed) };
      },
      "POST update/check": () => checkUpdate(),
      "POST update/apply": async () => {
        const found = update?.available ? update : await checkUpdate();
        if (!found?.available) throw new Error(found?.error || "No update is available.");
        return updater.apply(found.lock);
      },
      "POST update/rollback": () => updater.rollback(),
      // Stops this gateway at a moment with nothing in flight, waiting at most
      // `waitSeconds` for one. Answers { stopped: true } once the port is
      // closed and the backend has exited; the process then ends. Answers
      // { stopped: false, inFlight } when the wait ran out: nothing changed.
      "POST stop": async ({ waitSeconds = IDLE_WAIT_SECONDS }, _query, { res }) => {
        if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_IDLE_WAIT_SECONDS) throw new Error(`waitSeconds must be a whole number from 0 to ${MAX_IDLE_WAIT_SECONDS}.`);
        // A caller that goes away is not waited for: the gateway would stop
        // later with nobody there to start it again.
        const caller = new AbortController();
        const gone = () => caller.abort();
        if (res.destroyed) caller.abort();
        else res.once("close", gone);
        // The stop closes every connection but this one, which carries the answer.
        const socket = res.socket;
        answering.add(socket);
        if (inFlight()) log(`stop when idle requested: waiting up to ${waitSeconds} s (${inFlight()} in flight)`);
        const result = await stop({ whenIdle: true, waitMs: waitSeconds * 1000, signal: caller.signal });
        res.removeListener("close", gone);
        if (!result.stopped) {
          answering.delete(socket);
          log(caller.signal.aborted ? "stop when idle: the caller went away; the gateway keeps running" : `stop when idle: still ${result.inFlight} in flight after ${waitSeconds} s; the gateway keeps running`);
          return result;
        }
        res.setHeader("connection", "close");
        const answered = () => {
          answering.delete(socket);
          if (!answering.size && exit && !exited) {
            exited = true;
            exit();
          }
        };
        if (res.destroyed) setImmediate(answered);
        else res.once("close", answered);
        return result;
      }
    }
  });

  const gateway = createGateway({
    upstream: { host: settings.host, port: settings.backendPort },
    resolve: createResolver({ lanes: () => settings.lanes, isAvailable }),
    describe,
    // Which models can take an image. Read from the offered models (their
    // input lists) and refreshed on the same cache as the accounts.
    accountOf,
    supportsImages: (id) => {
      const model = imageModels().get(id);
      return model === undefined ? true : model;
    },
    failover,
    // When a subscription model's quota returns, from the provider's own usage
    // report (the cached one the Accounts page shows).
    quotaReset: async (model) => {
      const reset = await limits.quotaReset({ accounts: accounts.list(state.authDir), model });
      // The refusal may mean an account has just run out: let it step aside.
      order.refresh({ ifChosen: true });
      return reset;
    },
    sessions: createSessions(),
    log,
    status,
    control
  });

  // ---- Requests in flight, and stopping when there are none ----
  // Everything the gateway forwards is counted. What it answers itself is
  // not: its status and the control calls.
  const ownRequest = (req) => (req.method === "GET" && req.url === STATUS_PATH) || req.url.startsWith(CONTROL_PREFIX);
  inFlight = countRequests(gateway, (req) => !ownRequest(req), (count) => {
    // The moment a stop is waiting for. The port is closed before this tick
    // ends, so no request can be taken between the count and the stop.
    if (count === 0 && waiting.size && !stopping) {
      log("stopping at a moment with no request in flight");
      stopNow();
    }
  });
  const connections = new Set();
  gateway.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  // Stops that wait for an idle moment; the connections of the control calls
  // among them, which outlive the stop until they are answered.
  const waiting = new Set();
  const answering = new Set();
  let stopping = null;
  let exited = false;

  try {
    await new Promise((resolve, reject) => {
      gateway.once("error", (error) => reject(new Error(error.code === "EADDRINUSE" ? `Port ${settings.port} is already in use. Stop the program using it or change "port" in settings.json.` : error.message)));
      gateway.listen(settings.port, settings.host, resolve);
    });
  } catch (error) {
    await supervisor.stop();
    throw error;
  }
  log(`DSHProxy ${app.version} listening on ${state.origin} (backend ${lock.name} ${lock.version} on port ${settings.backendPort})`);

  // Model discovery shortly after start, then every few hours; the backend
  // update check after that and then every few hours.
  const timers = [
    setTimeout(() => discover().catch((error) => log(`model discovery failed: ${error.message}`)), 3000),
    // The backend needs a moment to load the accounts before it can be told.
    setTimeout(() => order.refresh(), 5000),
    setTimeout(() => checkUpdate(), 15000),
    setInterval(() => discover().catch((error) => log(`model discovery failed: ${error.message}`)), DISCOVERY_MS),
    setInterval(() => checkUpdate(), UPDATE_CHECK_MS)
  ];

  // Stops at once, cutting whatever is in flight. Resolves once the gateway
  // port is closed and the backend has exited. Asked again, it gives the same
  // answer: there is one stop.
  function stopNow() {
    if (stopping) return stopping;
    for (const timer of timers) clearTimeout(timer);
    order.stop();
    clearTimeout(changeTimer);
    logins.closeAll();
    fs.rmSync(paths.controlToken, { force: true });
    // The port stops accepting here, not later.
    gateway.close();
    const closed = [...connections].filter((socket) => !answering.has(socket)).map((socket) => new Promise((resolve) => {
      socket.once("close", resolve);
      socket.destroy();
    }));
    stopping = Promise.all([Promise.all(closed), supervisor.stop()]);
    for (const wait of [...waiting]) wait.settle(stopping.then(() => ({ stopped: true })));
    return stopping;
  }

  // Keeps serving until a moment with nothing in flight and stops then.
  // Resolves { stopped: true } once stopped, or { stopped: false, inFlight }
  // when `waitMs` passed, or `signal` was aborted, first: nothing changed then.
  function stopWhenIdle(waitMs, signal = null) {
    const stopped = () => ({ stopped: true });
    if (stopping) return stopping.then(stopped);
    if (signal?.aborted) return Promise.resolve({ stopped: false, inFlight: inFlight() });
    if (inFlight() === 0) {
      log("stopping at a moment with no request in flight");
      return stopNow().then(stopped);
    }
    if (!(waitMs > 0)) return Promise.resolve({ stopped: false, inFlight: inFlight() });
    return new Promise((resolve) => {
      const wait = {
        settle(value) {
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", giveUp);
          waiting.delete(wait);
          resolve(value);
        }
      };
      const giveUp = () => wait.settle({ stopped: false, inFlight: inFlight() });
      const timer = setTimeout(giveUp, Math.min(waitMs, MAX_TIMER_MS));
      if (signal) signal.addEventListener("abort", giveUp, { once: true });
      waiting.add(wait);
    });
  }

  // `stop()` stops at once. `stop({ whenIdle: true, waitMs, signal })` waits
  // for an idle moment, for `waitMs` at most (five minutes when not given);
  // aborting `signal` calls the wait off.
  const stop = (options) => (options?.whenIdle ? stopWhenIdle(options.waitMs === undefined ? IDLE_WAIT_SECONDS * 1000 : Number(options.waitMs), options.signal || null) : stopNow());
  return { origin: state.origin, status, stop, inFlight, log };
}

module.exports = { start };
