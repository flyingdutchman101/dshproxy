const fs = require("fs");
const os = require("os");
const path = require("path");
const { API_PROVIDERS, providerRegionKey } = require("./catalog");

// The gateway and its backend only ever listen on this machine. A setting that
// names any other address is ignored rather than widened.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

// Ladders from the DeepSeek Harness working defaults (~/.dsh/AGENTS.md). The
// reviewer ladder leaves out GPT: main and builder start on GPT, and automatic
// failover cannot check which model wrote the code under review.
//
// Each working lane names a second model on the Claude subscription outside
// Fable, and a model on the ChatGPT subscription: Fable has its own weekly
// limit, so a lane whose only Claude rung is Fable stops when that limit is
// used up although the account still serves Opus, Sonnet and Haiku.
const DEFAULT_LANES = {
  main: ["gpt-6-astra", "claude-fable-5-2", "claude-opus-5-5", "gemini-4-carbon-high", "deepseek/deepseek-v4-pro"],
  scout: ["claude-haiku-5-5", "gemini-3.8-flash-high", "gpt-6-luna", "deepseek/deepseek-flash", "qwen/qwen3.8-flash"],
  builder: ["gpt-6-astra", "claude-sonnet-5-5", "deepseek/deepseek-v4-pro", "gemini-4-argon-high"],
  architect: ["claude-fable-5-2", "gpt-6.1-terra", "claude-opus-5-5", "deepseek/deepseek-v4-pro", "gemini-4-argon-high"],
  reviewer: ["gemini-4-carbon-high", "deepseek/deepseek-v4-pro", "claude-opus-5-5"],
  // A Google-only ladder: one Gemini model being throttled no longer fails the
  // turn, the gateway cools it and answers from the next one.
  google: ["gemini-3.8-flash-high", "gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", "gemini-3.8-flash-tiered"]
};

const DEFAULTS = {
  host: "127.0.0.1",
  // 8317/8318 belong to VeryCuteDroidProxy; these let both run side by side.
  port: 8417,
  backendPort: 8418,
  authDir: "",
  cooldownMinutes: 10,
  failureThreshold: 3,
  custom: []
};

function homeDir() {
  return process.env.DSHPROXY_HOME || path.join(os.homedir(), ".dshproxy");
}

// The data folder was ~/.dshgate before the app was renamed. If only the old
// one exists, it is renamed in place (same drive, so sign-ins, keys and the
// downloaded backend move at once). An existing new folder is never touched.
function migrateHome(home = homeDir(), old = path.join(path.dirname(home), ".dshgate")) {
  if (fs.existsSync(home) || !fs.existsSync(old)) return { moved: false };
  fs.renameSync(old, home);
  const oldLog = path.join(home, "dshgate.log");
  if (fs.existsSync(oldLog)) fs.renameSync(oldLog, path.join(home, "dshproxy.log"));
  return { moved: true, from: old };
}

function paths(home = homeDir()) {
  return {
    home,
    settings: path.join(home, "settings.json"),
    config: path.join(home, "backend-config.yaml"),
    log: path.join(home, "dshproxy.log"),
    backendPid: path.join(home, "backend.pid"),
    controlToken: path.join(home, "control.token"),
    authDir: path.join(home, "auth"),
    binDir: path.join(home, "bin")
  };
}

function intIn(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function sanitizeLanes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.fromEntries(Object.entries(DEFAULT_LANES).map(([name, ladder]) => [name, [...ladder]]));
  }
  const lanes = {};
  for (const [name, ladder] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(name) || !Array.isArray(ladder)) continue;
    const rungs = [...new Set(ladder.map((item) => String(item).trim()).filter(Boolean))].slice(0, 8);
    if (rungs.length) lanes[name] = rungs;
  }
  return lanes;
}

function sanitizeProviders(value) {
  return Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
    .filter(([key, entry]) => API_PROVIDERS[key] && typeof entry?.keyEnc === "string" && entry.keyEnc)
    .map(([key, entry]) => [key, { region: providerRegionKey(key, entry.region), keyEnc: entry.keyEnc }]));
}

// A custom OpenAI-compatible endpoint: a self-hosted gateway such as LiteLLM or
// One API, or any other service that speaks the OpenAI API. It is addressed by
// key like any other provider, not by an account sign-in.
function sanitizeCustom(value) {
  const entries = Array.isArray(value) ? value : [];
  const seen = new Set();
  return entries
    .map((entry) => ({
      name: String(entry?.name || "").trim().toLowerCase(),
      baseUrl: String(entry?.baseUrl || "").trim(),
      models: [...new Set((Array.isArray(entry?.models) ? entry.models : []).map((model) => String(model).trim()).filter((model) => /^[A-Za-z0-9._:/-]{1,80}$/.test(model)))].slice(0, 100),
      keyEnc: typeof entry?.keyEnc === "string" ? entry.keyEnc : ""
    }))
    .filter((entry) => {
      if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(entry.name) || seen.has(entry.name)) return false;
      if (!/^https?:\/\/\S+$/.test(entry.baseUrl)) return false;
      if (!entry.models.length) return false;
      seen.add(entry.name);
      return true;
    })
    .slice(0, 20);
}

function sanitize(value = {}) {
  const port = intIn(value.port, 1024, 65535, DEFAULTS.port);
  let backendPort = intIn(value.backendPort, 1024, 65535, DEFAULTS.backendPort);
  if (backendPort === port) backendPort = port === 65535 ? port - 1 : port + 1;
  const host = String(value.host || "").trim();
  const cooldown = Number(value.cooldownMinutes);
  return {
    host: LOOPBACK_HOSTS.has(host) ? host : DEFAULTS.host,
    port,
    backendPort,
    authDir: typeof value.authDir === "string" ? value.authDir.trim() : DEFAULTS.authDir,
    cooldownMinutes: Number.isFinite(cooldown) && cooldown >= 1 && cooldown <= 360 ? cooldown : DEFAULTS.cooldownMinutes,
    failureThreshold: intIn(value.failureThreshold, 1, 10, DEFAULTS.failureThreshold),
    lanes: sanitizeLanes(value.lanes),
    providers: sanitizeProviders(value.providers),
    custom: sanitizeCustom(value.custom),
    models: sanitizeModels(value.models)
  };
}

// Models the user switched on (hidden by default) or off (offered by default).
function sanitizeModels(value) {
  const list = (items) => [...new Set((Array.isArray(items) ? items : []).map((item) => String(item).trim()).filter((item) => /^[A-Za-z0-9._:/-]{1,80}$/.test(item)))].slice(0, 200);
  return { extra: list(value?.extra), hidden: list(value?.hidden) };
}

// A missing file gives the defaults. A file that is there but cannot be read
// is an error: carrying on with the defaults would let the next save replace
// it, and the saved API keys and ladders with it.
function load(home = homeDir()) {
  const file = paths(home).settings;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return sanitize({});
    throw new Error(`${file} cannot be read (${error.message}).`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${error.message}). Fix it, or move it away to start from the defaults.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file} does not hold a settings object. Fix it, or move it away to start from the defaults.`);
  return sanitize(value);
}

// Written to a temporary file first, so an interrupted save cannot leave a
// half-written settings file.
function save(settings, home = homeDir()) {
  const clean = sanitize(settings);
  const file = paths(home).settings;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(clean, null, 2)}\n`);
  fs.renameSync(temporary, file);
  return clean;
}

function authDirFor(settings, home = homeDir()) {
  return settings.authDir || paths(home).authDir;
}

// Base URL clients use to reach the gateway.
function origin(settings) {
  const host = settings.host.includes(":") ? `[${settings.host}]` : settings.host;
  return `http://${host}:${settings.port}`;
}

module.exports = { DEFAULT_LANES, DEFAULTS, homeDir, migrateHome, paths, sanitize, load, save, authDirFor, origin, sanitizeCustom };
