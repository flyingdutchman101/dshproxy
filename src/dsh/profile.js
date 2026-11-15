// Writes the gateway's models into DeepSeek Harness as provider routes of the
// pi-ai plugin (~/.dsh/profiles/<profile>/cordis.patch.yml).
//
// Only the four `dshgate-*` routes are written or removed. Every other patch
// entry, route (including VeryCuteDroidProxy's `droidproxy-*`) and comment in
// the file is left as it is.

const fs = require("fs");
const os = require("os");
const path = require("path");
const YAML = require("yaml");

const PLUGIN_NAME = "@deepseek-ai/dsh-llm-pi-ai";
const ENTRY_ID = "llm-pi-ai";
const KEY_REF = "DSHGATE_API_KEY";
// The gateway ignores the key, but DeepSeek Harness refuses a route whose
// credential reference resolves to nothing.
const KEY_PLACEHOLDER = "dshgate-local";
const ADDED_MARK = " added by dshgate";

// Each model family is declared with its native protocol. Lanes use Anthropic
// Messages; CLIProxyAPI translates for whichever model serves the request.
const ROUTES = {
  "dshgate-lanes": { api: "lanes", protocol: "anthropic-messages", suffix: "", label: "dshgate · Lanes (automatic failover)" },
  "dshgate-claude": { api: "claude", protocol: "anthropic-messages", suffix: "", label: "dshgate · Claude" },
  "dshgate-openai": { api: "openai", protocol: "openai-responses", suffix: "/v1", label: "dshgate · GPT" },
  "dshgate-compat": { api: "compat", protocol: "openai-completions", suffix: "/v1", label: "dshgate · Gemini, Kimi and API keys" }
};

// DeepSeek Harness refuses an attachment unless the model declares it; `text`
// and `image` are the only modalities it accepts.
const DEFAULT_INPUT = ["text", "image"];
// Fields a sync owns. Anything else on a model entry belongs to the user.
const MANAGED_FIELDS = new Set(["id", "name", "contextWindow", "maxTokens", "reasoningEfforts"]);

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

const declaredInput = (entry) => (Array.isArray(entry?.input) && entry.input.length ? entry.input : null);

// `existing` is the model's entry already in the profile, if any: its `input`
// wins (the profile is where the user corrects what an endpoint accepts) and
// its other unmanaged fields are carried over.
function modelEntry(model, existing) {
  const entry = {
    id: model.id,
    name: model.name,
    input: declaredInput(existing) || [...DEFAULT_INPUT],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoningEfforts: model.efforts.length ? Object.fromEntries(model.efforts.map((level) => [level, level])) : false
  };
  for (const [key, value] of Object.entries(existing || {})) {
    if (!MANAGED_FIELDS.has(key) && key !== "input") entry[key] = value;
  }
  return entry;
}

// `previous` holds each route's current model entries. Models of the providers
// in `keepModelPrefixes` stay even when `models` no longer lists them: their
// saved API key cannot be read right now, which is not a removal.
function buildRoutes(models, origin, previous = {}, keepModelPrefixes = []) {
  const routes = {};
  for (const [key, route] of Object.entries(ROUTES)) {
    const before = new Map((previous[key] || []).filter((entry) => typeof entry?.id === "string").map((entry) => [entry.id, entry]));
    const list = models.filter((model) => model.api === route.api).map((model) => modelEntry(model, before.get(model.id)));
    const listed = new Set(list.map((entry) => entry.id));
    for (const [id, entry] of before) {
      if (listed.has(id) || !keepModelPrefixes.some((prefix) => id.startsWith(`${prefix}/`))) continue;
      list.push({ ...entry, input: declaredInput(entry) || [...DEFAULT_INPUT] });
    }
    if (!list.length) continue;
    routes[key] = { displayName: route.label, apiKeyEnv: KEY_REF, api: route.protocol, baseURL: `${origin}${route.suffix}`, models: list };
  }
  return routes;
}

function profiles(home = dshHome()) {
  try {
    return fs.readdirSync(path.join(home, "profiles"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function patchFile(profile, home = dshHome()) {
  return path.join(home, "profiles", profile, "cordis.patch.yml");
}

function readPatch(profile, home) {
  const file = patchFile(profile, home);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const doc = existing.trim() ? YAML.parseDocument(existing) : new YAML.Document([]);
  if (doc.errors.length) throw new Error(`${profile}/cordis.patch.yml has YAML errors (${doc.errors[0].message}); left unchanged.`);
  if (!doc.contents || !YAML.isSeq(doc.contents)) {
    if (doc.contents && !(YAML.isScalar(doc.contents) && doc.contents.value == null)) throw new Error(`${profile}/cordis.patch.yml is not a list of patch entries; left unchanged.`);
    doc.contents = doc.createNode([]);
  }
  return { file, existing, doc };
}

function findEntry(doc) {
  return doc.contents.items.find((item) => YAML.isMap(item) && (item.get("id") === ENTRY_ID || item.get("name") === PLUGIN_NAME)) || null;
}

// A backup name that is not in use yet. Two changes in the same millisecond
// still get separate files.
function backupPath(file) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace(/Z$/, "");
  let candidate = `${file}.dshgate-${stamp}.bak`;
  for (let count = 2; fs.existsSync(candidate); count += 1) candidate = `${file}.dshgate-${stamp}-${count}.bak`;
  return candidate;
}

// Written to a temporary file first, so an interrupted write cannot leave a
// half-written file.
function writeWhole(file, text) {
  const temporary = `${file}.dshgate-${process.pid}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

function writePatch({ file, existing, doc }, dryRun) {
  const text = doc.toString({ lineWidth: 0 });
  if (text === existing) return { changed: false, text };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (existing) fs.copyFileSync(file, backupPath(file));
    writeWhole(file, text);
  }
  return { changed: true, text };
}

// Adds the placeholder credential the routes refer to. A reference that is
// already there is never overwritten, and a file that is not in the form
// DeepSeek Harness writes is left alone. No backup copy is made: it would be a
// second file holding the user's credentials.
function ensureCredentialRef(home = dshHome(), dryRun = false) {
  const file = path.join(home, ".credentials.yaml");
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const doc = existing.trim() ? YAML.parseDocument(existing) : new YAML.Document(null);
    if (doc.errors.length) return { created: false, reason: `the credentials file has YAML errors (${doc.errors[0].message})` };
    const empty = doc.contents === null || (YAML.isScalar(doc.contents) && doc.contents.value == null);
    if (!empty && !YAML.isMap(doc.contents)) return { created: false, reason: "the credentials file is not in the expected form; add the DSHGATE_API_KEY reference by hand" };
    if (empty) doc.contents = doc.createNode({ version: 1, records: {}, refs: {} });
    const refs = doc.get("refs", true);
    if (refs === undefined || (YAML.isScalar(refs) && refs.value == null)) doc.set("refs", doc.createNode({}));
    else if (!YAML.isMap(refs)) return { created: false, reason: "the credentials file is not in the expected form; add the DSHGATE_API_KEY reference by hand" };
    if (doc.getIn(["refs", KEY_REF]) !== undefined) return { created: false, reason: "already present" };
    doc.setIn(["refs", KEY_REF], KEY_PLACEHOLDER);
    if (!dryRun) writeWhole(file, doc.toString({ lineWidth: 0 }));
    return { created: true };
  } catch (error) {
    return { created: false, reason: error.message };
  }
}

function applyToProfile(profile, models, origin, home = dshHome(), options = {}) {
  const patch = readPatch(profile, home);
  const { doc } = patch;
  let entry = findEntry(doc);
  if (!entry) {
    entry = doc.createNode({ id: ENTRY_ID, name: PLUGIN_NAME, config: { providers: {} } });
    // Marks the entry as dshgate's own, so `remove` can take it out again.
    entry.get("id", true).comment = ADDED_MARK;
    doc.contents.add(entry);
  }
  let providersNode = entry.getIn(["config", "providers"], true);
  if (!YAML.isMap(providersNode)) {
    entry.setIn(["config", "providers"], doc.createNode({}));
    providersNode = entry.getIn(["config", "providers"], true);
  }
  // An empty `{}` would otherwise have the routes written inside the braces.
  if (!providersNode.items.length) providersNode.flow = false;
  const previous = {};
  for (const key of Object.keys(ROUTES)) {
    const list = providersNode.getIn([key, "models"], true);
    previous[key] = YAML.isSeq(list) ? list.toJSON() : [];
  }
  const routes = buildRoutes(models, origin, previous, options.keepModelPrefixes || []);
  for (const key of Object.keys(ROUTES)) {
    if (!routes[key]) {
      providersNode.delete(key);
      continue;
    }
    const node = doc.createNode(routes[key]);
    // One line per model instead of a list entry per modality.
    for (const item of node.get("models", true).items) {
      const input = item.get("input", true);
      if (YAML.isSeq(input)) input.flow = true;
    }
    providersNode.set(key, node);
  }
  const written = Object.values(routes).flatMap((route) => route.models.map((model) => model.id));
  const requested = new Set(models.map((model) => model.id));
  const { changed, text } = writePatch(patch, options.dryRun);
  return {
    profile,
    file: patch.file,
    changed,
    routes: Object.fromEntries(Object.entries(routes).map(([key, route]) => [key, route.models.length])),
    kept: written.filter((id) => !requested.has(id)),
    text
  };
}

function apply(models, origin, home = dshHome(), options = {}) {
  const names = profiles(home);
  if (!names.length) throw new Error("DeepSeek Harness profiles were not found. Open DeepSeek Harness once, then try again.");
  if (!models.length) throw new Error("No models are available yet. Sign in to an account or add an API key first.");
  // Every profile is checked before any is written, so one unreadable profile
  // does not leave the others half-applied.
  for (const profile of names) readPatch(profile, home);
  const results = names.map((profile) => applyToProfile(profile, models, origin, home, options));
  return { profiles: results, credential: ensureCredentialRef(home, options.dryRun) };
}

// Removes the gateway's routes, and the plugin entry too when `apply` added it
// and nothing else is in it. The credential reference is left in place.
function remove(home = dshHome(), options = {}) {
  // Every profile is read before any is written.
  const patches = profiles(home).map((profile) => ({ profile, patch: readPatch(profile, home) }));
  return patches.map(({ profile, patch }) => {
    const entry = findEntry(patch.doc);
    const providersNode = entry?.getIn(["config", "providers"], true);
    const removed = [];
    if (YAML.isMap(providersNode)) {
      for (const key of Object.keys(ROUTES)) if (providersNode.delete(key)) removed.push(key);
      const ownEntry = entry.get("id", true)?.comment === ADDED_MARK;
      if (ownEntry && !providersNode.items.length) patch.doc.contents.items.splice(patch.doc.contents.items.indexOf(entry), 1);
    }
    return { profile, file: patch.file, removed, changed: writePatch(patch, options.dryRun).changed };
  });
}

function state(origin, home = dshHome()) {
  const result = { home, profiles: [] };
  for (const profile of profiles(home)) {
    let routes = [];
    let error = null;
    try {
      const providersNode = findEntry(readPatch(profile, home).doc)?.getIn(["config", "providers"], true);
      if (YAML.isMap(providersNode)) {
        routes = Object.keys(ROUTES).filter((key) => YAML.isMap(providersNode.get(key, true))).map((key) => ({
          key,
          baseURL: String(providersNode.getIn([key, "baseURL"]) || ""),
          models: (providersNode.getIn([key, "models"], true)?.items || []).length
        }));
      }
    } catch (failure) {
      error = failure.message;
    }
    const current = routes.length > 0 && routes.every((route) => route.baseURL.startsWith(origin));
    result.profiles.push({ profile, routes, current, error });
  }
  result.applied = result.profiles.length > 0 && result.profiles.every((item) => item.current);
  return result;
}

module.exports = { ROUTES, KEY_REF, dshHome, apply, remove, state, buildRoutes };
