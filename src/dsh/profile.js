// Writes the gateway's models into DeepSeek Harness as provider routes of the
// pi-ai plugin (~/.dsh/profiles/<profile>/cordis.patch.yml).
//
// Only the four `dshproxy-*` routes are written or removed. Every other patch
// entry, route (including VeryCuteDroidProxy's `droidproxy-*`) and comment in
// the file is left as it is.

const fs = require("fs");
const os = require("os");
const path = require("path");
const YAML = require("yaml");
const { laneId } = require("../catalog");

const PLUGIN_NAME = "@deepseek-ai/dsh-llm-pi-ai";
const ENTRY_ID = "llm-pi-ai";
const KEY_REF = "DSHPROXY_API_KEY";
// The gateway ignores the key, but DeepSeek Harness refuses a route whose
// credential reference resolves to nothing.
const KEY_PLACEHOLDER = "dshproxy-local";
const ADDED_MARK = " added by dshproxy";
// The app was called dshgate before; its routes and marks are migrated.
const LEGACY_ADDED_MARK = " added by dshgate";
const legacyKey = (key) => key.replace(/^dshproxy-/, "dshgate-");
// Providers shrink the per-image size limit once a request carries many
// images (Anthropic: 2000-3000 px instead of 8000). Keeping the retained count
// below that threshold makes DeepSeek Harness replace older images with text
// placeholders, so a long session with screenshots keeps completing.
const MAX_REQUEST_IMAGES = 12;
// Total base64 image payload per request. Beyond this, older images become text
// placeholders, which keeps the upstream token burst (and the provider quota)
// sane.
const MAX_REQUEST_IMAGE_BYTES = 8 * 1024 * 1024;

// Each model family is declared with its native protocol. Lanes use Anthropic
// Messages; CLIProxyAPI translates for whichever model serves the request.
const ROUTES = {
  "dshproxy-lanes": { api: "lanes", protocol: "anthropic-messages", suffix: "", label: "DSHProxy · Lanes (automatic failover)" },
  "dshproxy-claude": { api: "claude", protocol: "anthropic-messages", suffix: "", label: "DSHProxy · Claude" },
  "dshproxy-openai": { api: "openai", protocol: "openai-responses", suffix: "/v1", label: "DSHProxy · GPT" },
  "dshproxy-compat": { api: "compat", protocol: "openai-completions", suffix: "/v1", label: "DSHProxy · Gemini, Kimi and API keys" }
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
    input: declaredInput(existing) || (Array.isArray(model.input) && model.input.length ? [...model.input] : [...DEFAULT_INPUT]),
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
    routes[key] = { displayName: route.label, apiKeyEnv: KEY_REF, api: route.protocol, baseURL: `${origin}${route.suffix}`, maxRequestImages: MAX_REQUEST_IMAGES, maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES, models: list };
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
  let candidate = `${file}.dshproxy-${stamp}.bak`;
  for (let count = 2; fs.existsSync(candidate); count += 1) candidate = `${file}.dshproxy-${stamp}-${count}.bak`;
  return candidate;
}

// Written to a temporary file first, so an interrupted write cannot leave a
// half-written file.
function writeWhole(file, text) {
  const temporary = `${file}.dshproxy-${process.pid}.tmp`;
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
    if (!empty && !YAML.isMap(doc.contents)) return { created: false, reason: "the credentials file is not in the expected form; add the DSHPROXY_API_KEY reference by hand" };
    if (empty) doc.contents = doc.createNode({ version: 1, records: {}, refs: {} });
    const refs = doc.get("refs", true);
    if (refs === undefined || (YAML.isScalar(refs) && refs.value == null)) doc.set("refs", doc.createNode({}));
    else if (!YAML.isMap(refs)) return { created: false, reason: "the credentials file is not in the expected form; add the DSHPROXY_API_KEY reference by hand" };
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
    // Marks the entry as DSHProxy's own, so `remove` can take it out again.
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
  // Routes written before the rename (dshgate-*) are carried over and removed,
  // so the user's per-model settings survive and no duplicate routes remain.
  const previous = {};
  for (const key of Object.keys(ROUTES)) {
    const list = providersNode.getIn([key, "models"], true);
    const legacy = providersNode.getIn([legacyKey(key), "models"], true);
    previous[key] = YAML.isSeq(list) ? list.toJSON() : YAML.isSeq(legacy) ? legacy.toJSON() : [];
    providersNode.delete(legacyKey(key));
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

  // A profile needs a default model that exists. If none is set (or it names
  // something this gateway does not serve), point it at a lane so a new session
  // never starts on a model that is gone.
  let repairedDefault = false;
  const laneNames = Object.keys(options.lanes || {});
  const preferredLane = laneNames.includes("google") ? "google" : laneNames[0];
  const defaultEntry = doc.contents.items.find((item) => YAML.isMap(item) && String(item.get("id") || "") === "agent-default-model");
  const defaultProvider = defaultEntry ? String(defaultEntry.getIn(["config", "provider"]) || "") : "";
  const defaultModel = defaultEntry ? String(defaultEntry.getIn(["config", "model"]) || "") : "";
  const defaultOk = defaultEntry && ROUTES[defaultProvider] && (written.includes(defaultModel) || defaultModel.startsWith("lane-"));
  if (!defaultOk && preferredLane && routes["dshproxy-lanes"]) {
    const block = doc.createNode({ id: "agent-default-model", name: "@deepseek-ai/dsh-agent-default-model", config: { provider: "dshproxy-lanes", model: laneId(preferredLane) } });
    if (defaultEntry) doc.contents.items[doc.contents.items.indexOf(defaultEntry)] = block;
    else doc.contents.add(block);
    repairedDefault = true;
  }

  const { changed, text } = writePatch(patch, options.dryRun);
  return {
    profile,
    file: patch.file,
    changed: changed || repairedDefault,
    repairedDefault,
    routes: Object.fromEntries(Object.entries(routes).map(([key, route]) => [key, route.models.length])),
    kept: written.filter((id) => !requested.has(id)),
    text
  };
}

// Options: `only` limits the profiles written; `onlyApplied` writes only the
// profiles that already hold a DSHProxy route (used by automatic syncs, which
// must never add DSHProxy to a profile the user did not apply it to).
function hasRoutes(profile, home) {
  const providersNode = findEntry(readPatch(profile, home).doc)?.getIn(["config", "providers"], true);
  return YAML.isMap(providersNode) && Object.keys(ROUTES).some((key) => providersNode.has(key) || providersNode.has(legacyKey(key)));
}

function apply(models, origin, home = dshHome(), options = {}) {
  let names = profiles(home);
  if (!names.length) throw new Error("DeepSeek Harness profiles were not found. Open DeepSeek Harness once, then try again.");
  if (!models.length) throw new Error("No models are available yet. Sign in to an account or add an API key first.");
  if (options.only) names = names.filter((name) => options.only.includes(name));
  if (options.onlyApplied) {
    names = names.filter((name) => hasRoutes(name, home));
    if (!names.length) return { profiles: [], credential: { created: false, reason: "no profile has DSHProxy routes" } };
  }
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
      for (const key of Object.keys(ROUTES)) {
        if (providersNode.delete(key)) removed.push(key);
        if (providersNode.delete(legacyKey(key))) removed.push(legacyKey(key));
      }
      const ownEntry = [ADDED_MARK, LEGACY_ADDED_MARK].includes(entry.get("id", true)?.comment);
      if (ownEntry && !providersNode.items.length) patch.doc.contents.items.splice(patch.doc.contents.items.indexOf(entry), 1);
    }
    return { profile, file: patch.file, removed, changed: writePatch(patch, options.dryRun).changed };
  });
}


// Reads the profiles back and reports what would stop DeepSeek Harness from
// using DSHProxy: wrong or missing routes, stale or unrouted models, a missing
// default model, missing image caps, a leftover DroidProxy provider or a missing
// credential reference. Returns problems per profile; an empty list means the
// profile is ready.
// A route or lane is only expected while some offered model can serve it: when a
// provider is signed out or suspended its models disappear and the route goes
// with them, which is correct, not a problem.
function verify({ origin, lanes, models, home = dshHome() }) {
  const list = (models || []).map((model) => (typeof model === "string" ? { id: model, api: null } : { id: model.id, api: model.api || null }));
  const offered = new Set(list.map((model) => model.id));
  const requiredRoutes = Object.keys(ROUTES).filter((key) => list.some((model) => model.api === ROUTES[key].api));
  const laneIds = Object.keys(lanes || {})
    .filter((name) => (lanes[name] || []).some((id) => offered.has(id)))
    .map((name) => laneId(name));
  const result = { ok: true, profiles: [], credential: [] };

  const credentials = path.join(home, ".credentials.yaml");
  try {
    const text = fs.existsSync(credentials) ? fs.readFileSync(credentials, "utf8") : "";
    const doc = text.trim() ? YAML.parseDocument(text) : null;
    if (!doc || doc.getIn(["refs", KEY_REF]) === undefined) result.credential.push(`${path.basename(credentials)} has no ${KEY_REF} reference`);
  } catch (error) {
    result.credential.push(`.credentials.yaml cannot be read: ${error.message}`);
  }

  for (const profile of profiles(home)) {
    const problems = [];
    let providersNode = null;
    try {
      providersNode = findEntry(readPatch(profile, home).doc)?.getIn(["config", "providers"], true);
    } catch (error) {
      problems.push(error.message);
    }
    if (providersNode && YAML.isMap(providersNode)) {
      for (const key of requiredRoutes) {
        const route = providersNode.get(key, true);
        if (!YAML.isMap(route)) {
          problems.push(`route ${key} is missing`);
          continue;
        }
        const routeDef = ROUTES[key];
        const expected = `${origin}${routeDef.suffix}`;
        const baseURL = String(route.get("baseURL") || "");
        if (baseURL !== expected) problems.push(`${key}.baseURL is ${baseURL || "empty"}, expected ${expected}`);
        if (String(route.get("apiKeyEnv") || "") !== KEY_REF) problems.push(`${key}.apiKeyEnv is not ${KEY_REF}`);
        if (Number(route.get("maxRequestImages")) !== MAX_REQUEST_IMAGES) problems.push(`${key}.maxRequestImages is not ${MAX_REQUEST_IMAGES}`);
        if (Number(route.get("maxRequestImageBytes")) !== MAX_REQUEST_IMAGE_BYTES) problems.push(`${key}.maxRequestImageBytes is not ${MAX_REQUEST_IMAGE_BYTES}`);
        const ids = (route.get("models", true)?.items || []).map((item) => (YAML.isMap(item) ? String(item.get("id") || "") : "")).filter(Boolean);
        if (!ids.length) {
          problems.push(`${key} lists no models`);
          continue;
        }
        if (key === "dshproxy-lanes") {
          const missing = laneIds.filter((id) => !ids.includes(id));
          if (missing.length) problems.push(`${key} is missing ${missing.join(", ")}`);
        } else {
          const stale = ids.filter((id) => !offered.has(id));
          if (stale.length) problems.push(`${key} lists models that are no longer offered: ${stale.join(", ")}`);
        }
      }
      for (const item of providersNode.items || []) {
        const key = String(item?.key || "");
        if (key.startsWith("droidproxy-")) problems.push(`a DroidProxy provider (${key}) is still in this profile`);
      }
    } else if (!problems.length) {
      problems.push("the llm-pi-ai entry has no providers");
    }

    // The default model has to point at something that exists.
    try {
      const doc = readPatch(profile, home).doc;
      const entry = doc.contents.items.find((item) => YAML.isMap(item) && String(item.get("id") || "") === "agent-default-model");
      if (!entry) problems.push("no agent-default-model entry (a new session may start on a model that is gone)");
      else {
        const provider = String(entry.getIn(["config", "provider"]) || "");
        const model = String(entry.getIn(["config", "model"]) || "");
        if (!ROUTES[provider]) problems.push(`agent-default-model names provider ${provider || "(none)"}, which is not a DSHProxy route`);
        if (!laneIds.includes(model) && !offered.has(model)) problems.push(`agent-default-model names model ${model || "(none)"}, which is not offered`);
      }
    } catch (error) {
      problems.push(error.message);
    }

    if (problems.length) result.ok = false;
    result.profiles.push({ profile, problems });
  }
  if (result.credential.length) result.ok = false;
  return result;
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

module.exports = { ROUTES, KEY_REF, MAX_REQUEST_IMAGES, MAX_REQUEST_IMAGE_BYTES, dshHome, apply, remove, state, verify, buildRoutes };
