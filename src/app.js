// What the CLI and the running gateway both need to know: which accounts and
// API keys exist, and therefore which models can be offered.

const fs = require("fs");
const path = require("path");
const accounts = require("./accounts");
const catalog = require("./catalog");
const secrets = require("./secrets");
const settingsFile = require("./settings");
const { availability } = require("./lanes");
const { parseCatalog, buildModels, listModels, suggestions } = require("./models");

const { version } = require("../package.json");
const { compareVersions } = require("./backend/updater");

// The backend version shipped with DSHProxy, and the one an update installed.
const SHIPPED_LOCK = path.join(__dirname, "..", "backend.lock.json");

function lockFile(home = settingsFile.homeDir()) {
  return path.join(home, "backend.lock.json");
}

// The backend version to run: an installed update when it is at least as new
// as the shipped one, otherwise the shipped one. Read fresh every time, so an
// update or rollback takes effect on the next start.
function shippedLock() {
  return JSON.parse(fs.readFileSync(SHIPPED_LOCK, "utf8"));
}

function currentLock(home = settingsFile.homeDir()) {
  const shipped = shippedLock();
  try {
    const installed = JSON.parse(fs.readFileSync(lockFile(home), "utf8"));
    if (installed?.version && installed.assets && compareVersions(installed.version, shipped.version) >= 0) return installed;
  } catch {
    // no update installed
  }
  return shipped;
}

// The lock file updates write to. Created from the shipped lock on first use.
function writableLockFile(home = settingsFile.homeDir()) {
  const file = lockFile(home);
  // Also rewritten when the shipped version has overtaken it.
  let stale = false;
  try {
    stale = compareVersions(JSON.parse(fs.readFileSync(file, "utf8")).version, shippedLock().version) < 0;
  } catch {
    stale = true;
  }
  if (stale) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(currentLock(home), null, 2)}\n`);
  }
  return file;
}

function masterKeyFile(home) {
  return path.join(home, "master.key");
}

// Decrypts the saved API keys. `readable` is { [provider]: { region, apiKey } };
// `unreadable` lists providers whose saved key could not be decrypted.
async function readProviders(settings, home) {
  const readable = {};
  const unreadable = [];
  const saved = Object.entries(settings.providers);
  if (!saved.length) return { readable, unreadable };
  let key = null;
  try {
    key = await secrets.loadMasterKey(masterKeyFile(home));
  } catch {
    key = null;
  }
  for (const [provider, entry] of saved) {
    const apiKey = key ? secrets.decryptWithKey(key, entry.keyEnc) : null;
    if (apiKey) readable[provider] = { region: entry.region, apiKey };
    else unreadable.push(provider);
  }
  return { readable, unreadable };
}

// ------------------------------- custom endpoints -------------------------------
// A custom OpenAI-compatible endpoint (LiteLLM, One API, any OpenAI-shaped
// service) is stored by name with its key encrypted like any provider key.

async function readCustom(settings, home) {
  const saved = settings.custom || [];
  if (!saved.length) return { entries: [], unreadable: [] };
  let key = null;
  try { key = await secrets.loadMasterKey(masterKeyFile(home)); } catch { key = null; }
  const entries = [];
  const unreadable = [];
  for (const entry of saved) {
    const apiKey = key && entry.keyEnc ? secrets.decryptWithKey(key, entry.keyEnc) : null;
    if (!apiKey) { unreadable.push(entry.name); continue; }
    entries.push({ name: entry.name, baseUrl: entry.baseUrl, models: entry.models, apiKey });
  }
  return { entries, unreadable };
}

async function saveCustom({ name, baseUrl, models, apiKey }, home) {
  const clean = settingsFile.sanitizeCustom([{ name, baseUrl, models, keyEnc: "pending" }])[0];
  if (!clean) throw new Error("A custom endpoint needs a lowercase name (2-32 letters, digits or dashes), an http(s) base URL and at least one model ID.");
  const value = String(apiKey || "").trim();
  if (!value) throw new Error("No API key was given.");
  const key = await secrets.loadMasterKey(masterKeyFile(home), { create: true });
  const settings = settingsFile.load(home);
  const others = (settings.custom || []).filter((entry) => entry.name !== clean.name);
  settings.custom = [...others, { name: clean.name, baseUrl: clean.baseUrl, models: clean.models, keyEnc: secrets.encryptWithKey(key, value) }];
  settingsFile.save(settings, home);
  return clean.name;
}

function removeCustom(name, home) {
  const settings = settingsFile.load(home);
  const wanted = String(name || "").toLowerCase();
  const before = (settings.custom || []).length;
  settings.custom = (settings.custom || []).filter((entry) => entry.name !== wanted);
  if (settings.custom.length === before) return false;
  settingsFile.save(settings, home);
  return true;
}

async function saveProviderKey(provider, apiKey, region, home) {
  if (!catalog.API_PROVIDERS[provider]) throw new Error(`Unknown provider "${provider}". Use one of: ${Object.keys(catalog.API_PROVIDERS).join(", ")}.`);
  const value = String(apiKey || "").trim();
  if (!value) throw new Error("No API key was given.");
  const key = await secrets.loadMasterKey(masterKeyFile(home), { create: true });
  const settings = settingsFile.load(home);
  const chosen = catalog.regionForKey(provider, value, region || settings.providers[provider]?.region);
  settings.providers[provider] = { region: chosen, keyEnc: secrets.encryptWithKey(key, value) };
  settingsFile.save(settings, home);
  return chosen;
}

function removeProviderKey(provider, home) {
  const settings = settingsFile.load(home);
  if (!settings.providers[provider]) return false;
  delete settings.providers[provider];
  settingsFile.save(settings, home);
  return true;
}

// The model catalog and the backend's served list, as last saved by the
// running gateway. Missing files mean the hand-written list is used.
function discoveryFile(home = settingsFile.homeDir()) {
  return path.join(home, "models.json");
}

function readDiscovery(home = settingsFile.homeDir()) {
  try {
    const saved = JSON.parse(fs.readFileSync(discoveryFile(home), "utf8"));
    return { catalog: saved.catalog || null, served: Array.isArray(saved.served) ? saved.served : [], fetchedAt: saved.fetchedAt || null, catalogError: saved.catalogError || null };
  } catch {
    return { catalog: null, served: [], fetchedAt: null, catalogError: null };
  }
}

function saveDiscovery(home, value) {
  const file = discoveryFile(home);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

// The models that can serve right now, with the lanes that have at least one
// such model on their ladder. Subscription models come from what the backend
// serves and the model catalog, so new models need no DSHProxy update.
function offeredModels(settings, activeAccounts, readable, discovery = { catalog: null, served: [] }, custom = []) {
  const options = {
    catalog: parseCatalog(discovery.catalog),
    served: discovery.served,
    accounts: activeAccounts,
    extra: settings.models.extra,
    hidden: settings.models.hidden
  };
  const subscription = buildModels(options);
  const offeredIds = new Set(subscription.map((model) => model.id));
  const baseAvailable = availability({ accounts: activeAccounts, providers: readable });
  const real = [
    ...subscription,
    ...Object.entries(readable).flatMap(([provider, entry]) => catalog.providerModels(provider, entry.region)),
    // A custom OpenAI-compatible endpoint's models are addressed as
    // `<endpoint>/<model>`, so they cannot collide with anything else.
    ...custom.flatMap((endpoint) => endpoint.models.map((model) => ({
      id: `${endpoint.name}/${model}`,
      name: `${endpoint.name} · ${model}`,
      account: null,
      api: "compat",
      contextWindow: 200000,
      maxTokens: 65536,
      efforts: [],
      provider: endpoint.name,
      custom: true
    })))
  ];
  const customIds = new Set(real.filter((model) => model.custom).map((model) => model.id));
  // A subscription model is available when it is offered; API-key and custom
  // models when their key can be read.
  const isAvailable = (id) => customIds.has(id) || offeredIds.has(id) || (!catalog.findModel(id)?.account && baseAvailable(id));
  const sizes = new Map(real.map((model) => [model.id, model]));
  const lanes = catalog.laneModels(Object.fromEntries(Object.entries(settings.lanes)
    .map(([name, ladder]) => [name, ladder.filter(isAvailable)])
    .filter(([, ladder]) => ladder.length)), (id) => sizes.get(id));
  return { models: [...lanes, ...real], isAvailable, listed: listModels(options), suggestions: suggestions(settings.lanes, subscription) };
}

async function snapshot(home = settingsFile.homeDir()) {
  const settings = settingsFile.load(home);
  const authDir = settingsFile.authDirFor(settings, home);
  const { readable, unreadable } = await readProviders(settings, home);
  const customEndpoints = await readCustom(settings, home);
  const activeAccounts = accounts.activeProviders(authDir);
  const discovery = readDiscovery(home);
  return {
    home,
    settings,
    paths: settingsFile.paths(home),
    authDir,
    origin: settingsFile.origin(settings),
    accounts: accounts.list(authDir),
    activeAccounts,
    readable,
    unreadable,
    custom: customEndpoints.entries,
    customUnreadable: customEndpoints.unreadable,
    discovery: { fetchedAt: discovery.fetchedAt, catalogError: discovery.catalogError, hasCatalog: Boolean(discovery.catalog) },
    ...offeredModels(settings, activeAccounts, readable, discovery, customEndpoints.entries)
  };
}

function appendLog(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Logging must never stop the gateway.
  }
}

module.exports = { version, shippedLock, currentLock, writableLockFile, readDiscovery, saveDiscovery, snapshot, readProviders, saveProviderKey, removeProviderKey, readCustom, saveCustom, removeCustom, offeredModels, appendLog };
