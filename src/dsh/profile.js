// Writes the gateway's models into DeepSeek Harness as provider routes of the
// pi-ai plugin (~/.dsh/profiles/<profile>/cordis.patch.yml).
//
// Only the five `dshproxy-*` routes are written or removed. Every other patch
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
const VIDEO_ROUTE = "dshproxy-video";
// The video route is newer than the rename, so it has no old name: a route
// called `dshgate-video` would be somebody else's.
const legacyKey = (key) => (key === VIDEO_ROUTE ? null : key.replace(/^dshproxy-/, "dshgate-"));
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
//
// The video route lists paid video entries for a person to pick in the chat
// model picker. Picking one can lead to a purchase, so it differs from the
// other four: its entries are exactly the ones passed in (none is ever kept),
// DeepSeek Harness is told not to send a request again by itself, and the
// route must not be named anywhere an agent could select it (videoExposures).
// A long answer sends text while it waits; the idle limit is a margin.
const ROUTES = {
  "dshproxy-lanes": { api: "lanes", protocol: "anthropic-messages", suffix: "", label: "DSHProxy · Lanes (automatic failover)" },
  "dshproxy-claude": { api: "claude", protocol: "anthropic-messages", suffix: "", label: "DSHProxy · Claude" },
  "dshproxy-openai": { api: "openai", protocol: "openai-responses", suffix: "/v1", label: "DSHProxy · GPT" },
  "dshproxy-compat": { api: "compat", protocol: "openai-completions", suffix: "/v1", label: "DSHProxy · Gemini, Kimi and API keys" },
  [VIDEO_ROUTE]: { api: "video", protocol: "anthropic-messages", suffix: "/dshproxy/video", label: "DSHProxy · Video (paid)", options: { streamIdleTimeoutMs: 900000, retryPolicy: { mode: "normal", maxRetries: 0 } } }
};
const isVideo = (model) => model?.api === ROUTES[VIDEO_ROUTE].api;

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
// saved API key cannot be read right now, which is not a removal. That never
// applies to the video route: a video entry that is not passed is switched off.
function buildRoutes(models, origin, previous = {}, keepModelPrefixes = []) {
  const routes = {};
  for (const [key, route] of Object.entries(ROUTES)) {
    const before = new Map((previous[key] || []).filter((entry) => typeof entry?.id === "string").map((entry) => [entry.id, entry]));
    const list = models.filter((model) => model.api === route.api).map((model) => modelEntry(model, before.get(model.id)));
    const listed = new Set(list.map((entry) => entry.id));
    for (const [id, entry] of before) {
      if (key === VIDEO_ROUTE || listed.has(id) || !keepModelPrefixes.some((prefix) => id.startsWith(`${prefix}/`))) continue;
      list.push({ ...entry, input: declaredInput(entry) || [...DEFAULT_INPUT] });
    }
    if (!list.length) continue;
    // Route options sit beside the other route settings, where DeepSeek Harness
    // reads `streamIdleTimeoutMs` and `retryPolicy`.
    routes[key] = { displayName: route.label, apiKeyEnv: KEY_REF, api: route.protocol, baseURL: `${origin}${route.suffix}`, maxRequestImages: MAX_REQUEST_IMAGES, maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES, ...structuredClone(route.options || {}), models: list };
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
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    // The reason the profile could not be replaced is what the caller needs,
    // whatever happens to the temporary file.
    try {
      fs.rmSync(temporary, { force: true });
    } catch { /* swept later by tidy() */ }
    throw error;
  }
}

function writePatch({ file, existing, doc }, dryRun) {
  const text = doc.toString({ lineWidth: 0 });
  if (text === existing) return { changed: false, text };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (existing) {
      const backup = backupPath(file);
      fs.copyFileSync(file, backup);
      // A copy takes the mode of what it copies; on macOS it is made private.
      if (process.platform === "darwin") fs.chmodSync(backup, 0o600);
    }
    writeWhole(file, text);
    tidy(file);
  }
  return { changed: true, text };
}

const KEPT_BACKUPS = 10;
const STALE_TEMPORARY_MS = 60 * 60 * 1000;

// Keeps the newest backups this program made of `file` and removes the older
// ones, with any temporary file it left behind more than an hour ago. The
// stamp in a backup's name orders it. Files other programs made are not
// touched, and a file that cannot be removed is left for the next time.
function tidy(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.dshproxy-`;
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith(prefix));
  } catch {
    return;
  }
  const remove = (name) => {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch { /* in use or already gone */ }
  };
  // Only names in the form backupPath() writes: anything else is not ours.
  const backups = names.filter((name) => /^\d{8}T\d{9}(-\d+)?\.bak$/.test(name.slice(prefix.length))).sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - KEPT_BACKUPS))) remove(name);
  for (const name of names.filter((item) => /^\d+\.tmp$/.test(item.slice(prefix.length)))) {
    try {
      if (Date.now() - fs.statSync(path.join(dir, name)).mtimeMs > STALE_TEMPORARY_MS) remove(name);
    } catch { /* already gone */ }
  }
}

// On macOS DeepSeek Harness refuses a credentials file that group or others
// can read, so every apply leaves it readable by this account only. Windows
// is left as it is.
function keepPrivate(file) {
  if (process.platform === "darwin") fs.chmodSync(file, 0o600);
}

// What is wrong with the credentials file's mode on macOS, or null.
function credentialModeProblem(file) {
  if (process.platform !== "darwin" || !fs.existsSync(file)) return null;
  const mode = fs.statSync(file).mode & 0o777;
  if (!(mode & 0o077)) return null;
  return `${path.basename(file)} can be read by other accounts on this Mac (mode ${mode.toString(8)}), so DeepSeek Harness will not read it. Run \`dshproxy dsh apply\`, or \`chmod 600 ${file}\`.`;
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
    if (doc.getIn(["refs", KEY_REF]) !== undefined) {
      if (!dryRun) keepPrivate(file);
      return { created: false, reason: "already present" };
    }
    doc.setIn(["refs", KEY_REF], KEY_PLACEHOLDER);
    if (!dryRun) {
      writeWhole(file, doc.toString({ lineWidth: 0 }));
      keepPrivate(file);
    }
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
    const old = legacyKey(key);
    const legacy = old ? providersNode.getIn([old, "models"], true) : null;
    previous[key] = YAML.isSeq(list) ? list.toJSON() : YAML.isSeq(legacy) ? legacy.toJSON() : [];
    if (old) providersNode.delete(old);
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
    const retryPolicy = node.get("retryPolicy", true);
    if (YAML.isMap(retryPolicy)) retryPolicy.flow = true;
    providersNode.set(key, node);
  }
  const written = Object.values(routes).flatMap((route) => route.models.map((model) => model.id));
  const requested = new Set(models.map((model) => model.id));
  const chatModels = Object.keys(routes).filter((key) => key !== VIDEO_ROUTE).flatMap((key) => routes[key].models.map((model) => model.id));

  // A profile needs a default model that exists. If none is set (or it names
  // something this gateway does not serve), point it at a lane so a new session
  // never starts on a model that is gone. A video entry as the default is what
  // picking one in a chat leaves behind (decision 0008); applying sets a lane
  // again, so that new sessions start on a chat model.
  let repairedDefault = false;
  const laneNames = Object.keys(options.lanes || {});
  const preferredLane = laneNames.includes("google") ? "google" : laneNames[0];
  const defaultEntry = doc.contents.items.find((item) => YAML.isMap(item) && String(item.get("id") || "") === "agent-default-model");
  const defaultProvider = defaultEntry ? String(defaultEntry.getIn(["config", "provider"]) || "") : "";
  const defaultModel = defaultEntry ? String(defaultEntry.getIn(["config", "model"]) || "") : "";
  const defaultOk = defaultEntry && ROUTES[defaultProvider] && defaultProvider !== VIDEO_ROUTE && (chatModels.includes(defaultModel) || defaultModel.startsWith("lane-"));
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
  return YAML.isMap(providersNode) && Object.keys(ROUTES).some((key) => providersNode.has(key) || (legacyKey(key) !== null && providersNode.has(legacyKey(key))));
}

function apply(models, origin, home = dshHome(), options = {}) {
  let names = profiles(home);
  if (!names.length) throw new Error("DeepSeek Harness profiles were not found. Open DeepSeek Harness once, then try again.");
  // Video entries alone do not count: a profile whose only route is the paid
  // one would start every session on it.
  if (!models.some((model) => !isVideo(model))) throw new Error("No models are available yet. Sign in to an account or add an API key first.");
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
        const old = legacyKey(key);
        if (old && providersNode.delete(old)) removed.push(old);
      }
      const ownEntry = [ADDED_MARK, LEGACY_ADDED_MARK].includes(entry.get("id", true)?.comment);
      if (ownEntry && !providersNode.items.length) patch.doc.contents.items.splice(patch.doc.contents.items.indexOf(entry), 1);
    }
    return { profile, file: patch.file, removed, changed: writePatch(patch, options.dryRun).changed };
  });
}


// Every `{ provider: dshproxy-…, model }` pair in the profile, wherever it
// sits (a tool's agentOptions, the allowed subagent models), that names a route
// or a model the profile's own provider list does not have. The default model
// is left to its own check, and the video route to videoExposures, which
// reports it whether the route is defined or not. Each is described by the
// nearest entry ID.
function danglingReferences(doc, providersNode) {
  const defined = new Map();
  for (const pair of YAML.isMap(providersNode) ? providersNode.items : []) {
    const models = YAML.isMap(pair.value) ? pair.value.get("models", true) : null;
    defined.set(String(pair.key), new Set((YAML.isSeq(models) ? models.items : []).map((item) => (YAML.isMap(item) ? String(item.get("id") || "") : ""))));
  }
  const found = [];
  YAML.visit(doc, {
    Map(_key, node, ancestors) {
      const provider = node.get("provider");
      const model = node.get("model");
      if (typeof provider !== "string" || typeof model !== "string" || !provider.startsWith("dshproxy-") || provider === VIDEO_ROUTE) return;
      if (defined.get(provider)?.has(model)) return;
      const owner = [...ancestors].reverse().find((item) => YAML.isMap(item) && typeof item.get("id") === "string");
      const name = owner ? owner.get("id") : "an entry";
      if (name === "agent-default-model") return;
      found.push(`${name} names ${provider}/${model}, which this profile does not define (the tool would fail)`);
    }
  });
  return [...new Set(found)].sort();
}

// A profile larger than this is not searched to the end; it is treated as one
// that cannot be read.
const MAX_SEARCHED_NODES = 200000;

// Every place outside the provider list where the profile names the video
// route as a provider for agents: the allowed subagent models, a tool's
// agentOptions, or any other mapping with `provider: dshproxy-video`. Any of
// them would let an agent reach a route that can buy.
// The default model itself is the one place that is not counted: DeepSeek
// Harness saves the model a person picks in a chat there, so a picked video
// entry is always named in it (decision 0008).
// A mapping reused by reference (`*name`, `<<`) is read where it is used.
// Each place is `{ where, model }`, `where` being the nearest entry ID and the
// path below it.
function videoExposures(doc) {
  const providersNode = findEntry(doc)?.getIn(["config", "providers"], true);
  const plain = (node) => {
    const target = YAML.isAlias(node) ? node.resolve(doc) : node;
    return YAML.isScalar(target) ? target.value : undefined;
  };
  const found = [];
  let searched = 0;
  // `entry`: this node is one of the profile's own entries. `ownerIsEntry`:
  // the entry ID in `owner` was read from one of those, not from a mapping
  // further down that merely has an `id`.
  const walk = (node, owner, trail, followed, entry = false, ownerIsEntry = false) => {
    if (!node || node === providersNode) return;
    searched += 1;
    if (searched > MAX_SEARCHED_NODES) throw new Error("the profile is too large to search for the paid video route");
    if (YAML.isAlias(node)) {
      // A reference that leads back to itself ends here.
      if (!followed.includes(node)) walk(node.resolve(doc), owner, trail, [...followed, node], entry, ownerIsEntry);
      return;
    }
    if (YAML.isSeq(node)) {
      // An entry without an ID is named by its position in the file.
      const top = node === doc.contents;
      node.items.forEach((item, index) => walk(item, owner, top ? `entry ${index + 1}` : `${trail}[${index}]`, followed, top, top ? false : ownerIsEntry));
      return;
    }
    if (!YAML.isMap(node)) return;
    const id = plain(node.get("id", true));
    if (typeof id === "string" && id) [owner, trail, ownerIsEntry] = [id, "", entry];
    if (plain(node.get("provider", true)) === VIDEO_ROUTE) {
      const model = plain(node.get("model", true));
      const where = owner ? `${owner}${trail ? ` at ${trail}` : ""}` : `the profile at ${trail}`;
      const pickedDefault = ownerIsEntry && owner === "agent-default-model" && trail === "config";
      if (!pickedDefault) found.push({ where, model: typeof model === "string" ? model : "" });
    }
    for (const pair of node.items) {
      const key = String(YAML.isScalar(pair.key) ? pair.key.value : pair.key);
      walk(pair.value, owner, trail ? `${trail}.${key}` : key, followed, false, ownerIsEntry);
    }
  };
  walk(doc.contents, null, "", []);
  return found;
}

function exposureProblem({ where, model }) {
  return `${where} names ${VIDEO_ROUTE}${model ? `/${model}` : ""}: the paid video route must not be selectable for agents. Remove it there.`;
}

// True when any DeepSeek Harness profile names the video route for agents
// (see videoExposures). The gateway asks this before a purchase,
// so every doubt counts as exposed: a profile that cannot be read or parsed,
// and a profiles folder that cannot be listed. Reads only.
function videoExposed(home = dshHome()) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(home, "profiles"), { withFileTypes: true });
  } catch (error) {
    // No DeepSeek Harness on this machine names nothing.
    return error.code !== "ENOENT";
  }
  // A linked folder is a profile to DeepSeek Harness as well.
  return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).some((entry) => {
    try {
      return videoExposures(readPatch(entry.name, home).doc).length > 0;
    } catch {
      return true;
    }
  });
}

// What is wrong with the video route of a profile: its entries are not the
// offered ones, or DeepSeek Harness would send a request to it again by itself.
function videoRouteProblems(route, listed, wanted) {
  const problems = [];
  const fix = "run `dshproxy dsh apply`";
  const missing = wanted.filter((id) => !listed.includes(id));
  const extra = listed.filter((id) => !wanted.includes(id));
  if (!wanted.length) problems.push(`${VIDEO_ROUTE} is in this profile${listed.length ? ` with ${listed.join(", ")}` : ""}, but no video entry is offered; ${fix} to remove it`);
  else if (missing.length || extra.length) {
    if (missing.length) problems.push(`${VIDEO_ROUTE} does not list ${missing.join(", ")}; ${fix} to add ${missing.length > 1 ? "them" : "it"}`);
    if (extra.length) problems.push(`${VIDEO_ROUTE} lists video entries that are no longer offered: ${extra.join(", ")}; ${fix} to remove ${extra.length > 1 ? "them" : "it"}`);
  } else if (listed.join("\n") !== wanted.join("\n")) problems.push(`${VIDEO_ROUTE} lists its entries in another order than they are offered; ${fix}`);
  const retries = route.getIn(["retryPolicy", "maxRetries"]);
  if (retries !== 0) problems.push(`${VIDEO_ROUTE}.retryPolicy.maxRetries is ${retries === undefined ? "not set" : JSON.stringify(retries)}, expected 0 (a paid request must not be sent again automatically); ${fix}`);
  return problems;
}

// Reads the profiles back and reports what would stop DeepSeek Harness from
// using DSHProxy: wrong or missing routes, stale or unrouted models, a missing
// default model, missing image caps, a leftover DroidProxy provider or a missing
// credential reference. Returns problems per profile; an empty list means the
// profile is ready.
// A route or lane is only expected while some offered model can serve it: when a
// provider is signed out or suspended its models disappear and the route goes
// with them, which is correct, not a problem.
// The video route is held to more: its entries have to be the offered ones, in
// their order, it must not be re-sent to automatically, and nothing outside the
// provider list may name it.
function verify({ origin, lanes, models, home = dshHome() }) {
  const list = (models || []).map((model) => (typeof model === "string" ? { id: model, api: null } : { id: model.id, api: model.api || null }));
  // Video entries are offered on the video route only: they are no model of a
  // chat route, no member of a lane and no default model.
  const videoIds = list.filter(isVideo).map((model) => model.id);
  const offered = new Set(list.filter((model) => !isVideo(model)).map((model) => model.id));
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
    const modeProblem = credentialModeProblem(credentials);
    if (modeProblem) result.credential.push(modeProblem);
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
      // A video route that is still in the profile is checked even when no
      // video entry is offered any more.
      const checked = providersNode.has(VIDEO_ROUTE) && !requiredRoutes.includes(VIDEO_ROUTE) ? [...requiredRoutes, VIDEO_ROUTE] : requiredRoutes;
      for (const key of checked) {
        const route = providersNode.get(key, true);
        if (!YAML.isMap(route)) {
          if (key !== VIDEO_ROUTE) problems.push(`route ${key} is missing`);
          else if (videoIds.length) problems.push(`route ${key} is missing (it should list ${videoIds.join(", ")}); run \`dshproxy dsh apply\``);
          else problems.push(`${key} is in this profile, but no video entry is offered; run \`dshproxy dsh apply\` to remove it`);
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
        if (key === VIDEO_ROUTE) {
          problems.push(...videoRouteProblems(route, ids, videoIds));
          continue;
        }
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
        // A default on the video route is the entry a person picked in a chat
        // (decision 0008); it has to be one that is offered.
        if (provider === VIDEO_ROUTE) {
          if (!videoIds.includes(model)) problems.push(`agent-default-model names model ${model || "(none)"}, which is not offered`);
        } else {
          if (!ROUTES[provider]) problems.push(`agent-default-model names provider ${provider || "(none)"}, which is not a DSHProxy route`);
          if (!laneIds.includes(model) && !offered.has(model)) problems.push(`agent-default-model names model ${model || "(none)"}, which is not offered`);
        }
      }
    } catch (error) {
      problems.push(error.message);
    }

    // Tools and the subagent model list name routes too. One that names a
    // DSHProxy route or model this profile does not define fails when it is
    // used, long after the profile was written. One that names the video route
    // could buy.
    try {
      const doc = readPatch(profile, home).doc;
      problems.push(...danglingReferences(doc, providersNode));
      problems.push(...videoExposures(doc).map(exposureProblem));
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

module.exports = { ROUTES, KEY_REF, MAX_REQUEST_IMAGES, MAX_REQUEST_IMAGE_BYTES, dshHome, apply, remove, state, verify, videoExposed, buildRoutes };
