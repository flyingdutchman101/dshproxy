// Starts the backend and the gateway and keeps them running.

const crypto = require("crypto");
const fs = require("fs");
const accounts = require("./accounts");
const app = require("./app");
const { render } = require("./backend/config");
const { install } = require("./backend/install");
const { createManagement } = require("./backend/management");
const { createSupervisor } = require("./backend/supervisor");
const { createControl, newToken, writeToken } = require("./control");
const { createFailover } = require("./gateway/failover");
const { createGateway } = require("./gateway/server");
const { createSessions } = require("./gateway/sessions");
const { createResolver, describe, availability } = require("./lanes");
const { createLimits } = require("./limits");
const { applyPrimary } = require("./primary");
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

// The model IDs and figures DeepSeek Harness is given, for comparing two lists.
function fingerprint(models) {
  return JSON.stringify(models.map((model) => [model.id, model.api, model.contextWindow, model.maxTokens, model.efforts, model.input]).sort());
}

// `restart()` stops this gateway and starts it again (on the backend version
// now in the lock file). The Windows app and the CLI supply it.
async function start({ home, print = console.log, restart = null } = {}) {
  let state = await app.snapshot(home);
  const { settings, paths } = state;
  const log = (line) => {
    app.appendLog(paths.log, line);
    print(line);
  };
  const lock = app.currentLock(state.home);

  const backend = await install(lock, paths.binDir, { log });
  fs.mkdirSync(state.authDir, { recursive: true });
  // A new Management API key every start. Only this process knows it; the
  // backend stores a hash of it.
  const managementKey = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(paths.config, render({ host: settings.host, port: settings.backendPort, authDir: state.authDir, providers: state.readable, custom: state.custom, managementKey }));
  if (state.unreadable.length) log(`Saved API key cannot be read for: ${state.unreadable.join(", ")}. Enter it again with \`dshproxy key set\`.`);

  const supervisor = createSupervisor({ binary: backend.path, configPath: paths.config, host: settings.host, port: settings.backendPort, pidFile: paths.backendPid, log });
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
  const status = () => ({
    version: app.version,
    startedAt,
    origin: state.origin,
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
    // The backend needs a moment to load a changed account.
    setTimeout(refreshPrimary, 2000);
  };

  // Tells the backend which account of each provider goes first. An account
  // the usage report shows as out of quota steps aside, and this runs again a
  // minute after its limit resets. Callers that arrive while it runs share it.
  let applyingPrimary = null;
  let primaryTimer = null;
  const hasPrimary = () => Object.keys(settings.primary).length > 0;
  const usePrimary = () => {
    if (applyingPrimary) return applyingPrimary;
    const run = (async () => {
      const list = accounts.list(state.authDir);
      // Without a choice there is nothing to read the usage report for.
      const usedUp = hasPrimary() ? await limits.usedUp({ accounts: list }).catch(() => new Map()) : new Map();
      const result = await applyPrimary({ management, accounts: list, primary: settings.primary, usedUp: new Set(usedUp.keys()) });
      const name = (file) => {
        const account = list.find((item) => item.file === file);
        return account ? `${account.label} (${account.account})` : file;
      };
      for (const item of result.failed) log(`account order: ${name(item.file)} could not be set (${item.error})`);
      for (const file of result.changed) {
        log(usedUp.has(file) ? `account order: ${name(file)} is out of quota and steps aside until ${new Date(usedUp.get(file)).toLocaleString()}` : `account order: ${name(file)} is ${settings.primary[list.find((item) => item.file === file)?.provider] === file ? "the primary account" : "used after the primary account"}`);
      }
      clearTimeout(primaryTimer);
      if (usedUp.size) {
        const wait = Math.min(...usedUp.values()) - Date.now() + 60 * 1000;
        primaryTimer = setTimeout(refreshPrimary, Math.min(Math.max(wait, 60 * 1000), 2 ** 31 - 1));
      }
      return result;
    })().finally(() => {
      if (applyingPrimary === run) applyingPrimary = null;
    });
    applyingPrimary = run;
    return run;
  };
  const refreshPrimary = () => {
    if (hasPrimary()) usePrimary().catch((error) => log(`account order not applied: ${error.message}`));
  };

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
        // A run that started before the choice changed has to finish first.
        if (applyingPrimary) await applyingPrimary.catch(() => {});
        const result = await usePrimary();
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
      "POST update/rollback": () => updater.rollback()
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
      refreshPrimary();
      return reset;
    },
    sessions: createSessions(),
    log,
    status,
    control
  });

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
    setTimeout(refreshPrimary, 5000),
    setTimeout(() => checkUpdate(), 15000),
    setInterval(() => discover().catch((error) => log(`model discovery failed: ${error.message}`)), DISCOVERY_MS),
    setInterval(() => checkUpdate(), UPDATE_CHECK_MS)
  ];

  // Resolves once the gateway port is closed and the backend has exited.
  const stop = () => {
    for (const timer of timers) clearTimeout(timer);
    clearTimeout(primaryTimer);
    logins.closeAll();
    fs.rmSync(paths.controlToken, { force: true });
    const closed = new Promise((resolve) => gateway.close(() => resolve()));
    gateway.closeAllConnections();
    return Promise.all([closed, supervisor.stop()]);
  };
  return { origin: state.origin, status, stop };
}

module.exports = { start };
