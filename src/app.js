// What the CLI and the running gateway both need to know: which accounts and
// API keys exist, and therefore which models can be offered.

const fs = require("fs");
const path = require("path");
const accounts = require("./accounts");
const catalog = require("./catalog");
const secrets = require("./secrets");
const settingsFile = require("./settings");
const { availability } = require("./lanes");

const lock = require("../backend.lock.json");
const { version } = require("../package.json");

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

// The models that can serve right now, with the lanes that have at least one
// such model on their ladder.
function offeredModels(settings, activeAccounts, readable) {
  const isAvailable = availability({ accounts: activeAccounts, providers: readable });
  const real = [
    ...catalog.subscriptionModels().filter((model) => activeAccounts.has(model.account)),
    ...Object.entries(readable).flatMap(([provider, entry]) => catalog.providerModels(provider, entry.region))
  ];
  const lanes = catalog.laneModels(Object.fromEntries(Object.entries(settings.lanes)
    .map(([name, ladder]) => [name, ladder.filter(isAvailable)])
    .filter(([, ladder]) => ladder.length)));
  return { models: [...lanes, ...real], isAvailable };
}

async function snapshot(home = settingsFile.homeDir()) {
  const settings = settingsFile.load(home);
  const authDir = settingsFile.authDirFor(settings, home);
  const { readable, unreadable } = await readProviders(settings, home);
  const activeAccounts = accounts.activeProviders(authDir);
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
    ...offeredModels(settings, activeAccounts, readable)
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

module.exports = { lock, version, snapshot, readProviders, saveProviderKey, removeProviderKey, offeredModels, appendLog };
