const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const YAML = require("yaml");

const profile = require("../src/dsh/profile");

const ORIGIN = "http://127.0.0.1:8417";

const model = (id, api, extra = {}) => ({ id, name: id, api, contextWindow: 200000, maxTokens: 64000, efforts: ["low", "high"], ...extra });
const MODELS = [
  model("lane-main", "lanes"),
  model("claude-fable-5-2", "claude"),
  model("gpt-6-astra", "openai"),
  model("gemini-4-carbon-high", "compat", { efforts: ["high"] }),
  model("mistral/codestral-2508", "compat", { efforts: [] })
];
const API_KEY = [model("deepseek/deepseek-v4-pro", "compat"), model("qwen/qwen3.8-max", "compat")];

function tempHome(t, names = ["desktop"]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshgate-profile-"));
  for (const name of names) fs.mkdirSync(path.join(home, "profiles", name), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const patchPath = (home, name = "desktop") => path.join(home, "profiles", name, "cordis.patch.yml");
const providers = (home, name = "desktop") => YAML.parse(fs.readFileSync(patchPath(home, name), "utf8")).find((item) => item.id === "llm-pi-ai").config.providers;
const ids = (route) => route.models.map((entry) => entry.id);
const backups = (home, name = "desktop") => fs.readdirSync(path.join(home, "profiles", name)).filter((file) => file.endsWith(".bak"));

// A profile as VeryCuteDroidProxy and the user leave it.
const EXISTING = [
  "# Your patch layer for this dsh profile.",
  "- id: ui-chat",
  "  config:",
  "    transcriptView: standard",
  "# VeryCuteDroidProxy: written by the app.",
  "- id: llm-pi-ai",
  "  name: \"@deepseek-ai/dsh-llm-pi-ai\"",
  "  config:",
  "    providers:",
  "      droidproxy-claude:",
  "        apiKeyEnv: DROIDPROXY_API_KEY",
  "        api: anthropic-messages",
  "        baseURL: http://127.0.0.1:8317",
  "        models:",
  "          - id: claude-fable-5-2",
  "            input: [ text, image ]",
  "      my-gateway:",
  "        api: openai-completions",
  "        baseURL: https://gateway.example/v1",
  "        models:",
  "          - id: my-model",
  "- id: agent-default-model",
  "  config:",
  "    model: gpt-6-astra",
  ""
].join("\n");

test("each model lands on the route for its protocol", (t) => {
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home);
  const routes = providers(home);
  assert.deepEqual(ids(routes["dshgate-lanes"]), ["lane-main"]);
  assert.deepEqual(ids(routes["dshgate-claude"]), ["claude-fable-5-2"]);
  assert.deepEqual(ids(routes["dshgate-openai"]), ["gpt-6-astra"]);
  assert.deepEqual(ids(routes["dshgate-compat"]), ["gemini-4-carbon-high", "mistral/codestral-2508"]);
  assert.equal(routes["dshgate-lanes"].api, "anthropic-messages");
  assert.equal(routes["dshgate-lanes"].baseURL, "http://127.0.0.1:8417");
  assert.equal(routes["dshgate-claude"].baseURL, "http://127.0.0.1:8417");
  assert.equal(routes["dshgate-openai"].api, "openai-responses");
  assert.equal(routes["dshgate-openai"].baseURL, "http://127.0.0.1:8417/v1");
  assert.equal(routes["dshgate-compat"].api, "openai-completions");
  assert.equal(routes["dshgate-compat"].baseURL, "http://127.0.0.1:8417/v1");
});

test("a model entry declares its sizes, inputs and reasoning levels", (t) => {
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home);
  const routes = providers(home);
  assert.deepEqual(routes["dshgate-compat"].models[0], {
    id: "gemini-4-carbon-high",
    name: "gemini-4-carbon-high",
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    reasoningEfforts: { high: "high" }
  });
  // A model without reasoning levels is declared as non-reasoning.
  assert.equal(routes["dshgate-compat"].models[1].reasoningEfforts, false);
});

test("the routes refer to a credential that exists", (t) => {
  const home = tempHome(t);
  const result = profile.apply(MODELS, ORIGIN, home);
  assert.equal(result.credential.created, true);
  const ref = providers(home)["dshgate-claude"].apiKeyEnv;
  const credentials = YAML.parse(fs.readFileSync(path.join(home, ".credentials.yaml"), "utf8"));
  assert.equal(typeof credentials.refs[ref], "string");
  assert.ok(credentials.refs[ref].length > 0);
});

test("credentials that are already saved are kept", (t) => {
  const home = tempHome(t);
  const file = path.join(home, ".credentials.yaml");
  fs.writeFileSync(file, "version: 1\nrecords:\n  some/record:\n    kind: api-key\nrefs:\n  DEEPSEEK_API_KEY: existing-value\n  DSHGATE_API_KEY: chosen-by-user\n");
  const result = profile.apply(MODELS, ORIGIN, home);
  assert.equal(result.credential.created, false);
  assert.deepEqual(YAML.parse(fs.readFileSync(file, "utf8")), {
    version: 1,
    records: { "some/record": { kind: "api-key" } },
    refs: { DEEPSEEK_API_KEY: "existing-value", DSHGATE_API_KEY: "chosen-by-user" }
  });
});

test("VeryCuteDroidProxy's routes, other routes, other entries and comments are untouched", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(patchPath(home), EXISTING);
  profile.apply(MODELS, ORIGIN, home);
  const text = fs.readFileSync(patchPath(home), "utf8");
  const doc = YAML.parse(text);
  const before = YAML.parse(EXISTING);
  assert.deepEqual(doc[0], before[0]);
  assert.deepEqual(doc[2], before[2]);
  assert.deepEqual(doc[1].config.providers["droidproxy-claude"], before[1].config.providers["droidproxy-claude"]);
  assert.deepEqual(doc[1].config.providers["my-gateway"], before[1].config.providers["my-gateway"]);
  assert.ok(text.includes("# Your patch layer for this dsh profile."));
  assert.ok(text.includes("# VeryCuteDroidProxy: written by the app."));
  assert.deepEqual(ids(doc[1].config.providers["dshgate-lanes"]), ["lane-main"]);
});

test("the profile is backed up before it is changed", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(patchPath(home), EXISTING);
  profile.apply(MODELS, ORIGIN, home);
  const files = backups(home);
  assert.equal(files.length, 1);
  assert.equal(fs.readFileSync(path.join(home, "profiles", "desktop", files[0]), "utf8"), EXISTING);
});

test("a second identical sync changes nothing and writes no backup", (t) => {
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home);
  const result = profile.apply(MODELS, ORIGIN, home);
  assert.equal(result.profiles[0].changed, false);
  assert.equal(backups(home).length, 0);
});

test("a sync keeps fields the user added to a model", (t) => {
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home);
  const doc = YAML.parse(fs.readFileSync(patchPath(home), "utf8"));
  const gemini = doc.find((item) => item.id === "llm-pi-ai").config.providers["dshgate-compat"].models[0];
  gemini.input = ["text"];
  gemini.compat = { supportsDeveloperRole: false };
  fs.writeFileSync(patchPath(home), YAML.stringify(doc));

  profile.apply(MODELS, ORIGIN, home);

  const after = providers(home)["dshgate-compat"].models[0];
  assert.deepEqual(after.input, ["text"]);
  assert.deepEqual(after.compat, { supportsDeveloperRole: false });
});

test("a model that is no longer offered is removed", (t) => {
  const home = tempHome(t);
  profile.apply([...MODELS, ...API_KEY], ORIGIN, home);
  profile.apply(MODELS, ORIGIN, home);
  assert.deepEqual(ids(providers(home)["dshgate-compat"]), ["gemini-4-carbon-high", "mistral/codestral-2508"]);
});

test("models of a provider whose saved key cannot be read are kept", (t) => {
  const home = tempHome(t);
  profile.apply([...MODELS, ...API_KEY], ORIGIN, home);
  // Qwen was removed by the user; DeepSeek's key is unreadable right now.
  const result = profile.apply(MODELS, ORIGIN, home, { keepModelPrefixes: ["deepseek"] });
  assert.deepEqual(ids(providers(home)["dshgate-compat"]), ["gemini-4-carbon-high", "mistral/codestral-2508", "deepseek/deepseek-v4-pro"]);
  assert.deepEqual(result.profiles[0].kept, ["deepseek/deepseek-v4-pro"]);
});

test("a route with no models left is removed", (t) => {
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home);
  profile.apply(MODELS.filter((item) => item.api !== "openai"), ORIGIN, home);
  assert.equal(providers(home)["dshgate-openai"], undefined);
});

test("a dry run reports the change and writes nothing", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(patchPath(home), EXISTING);
  const result = profile.apply(MODELS, ORIGIN, home, { dryRun: true });
  assert.equal(result.profiles[0].changed, true);
  assert.deepEqual(result.profiles[0].routes, { "dshgate-lanes": 1, "dshgate-claude": 1, "dshgate-openai": 1, "dshgate-compat": 2 });
  assert.equal(fs.readFileSync(patchPath(home), "utf8"), EXISTING);
  assert.equal(backups(home).length, 0);
  assert.equal(fs.existsSync(path.join(home, ".credentials.yaml")), false);
});

test("a profile that cannot be parsed stops the sync before anything is written", (t) => {
  const home = tempHome(t, ["desktop", "web"]);
  const broken = "- id: llm-pi-ai\n  config: [unclosed\n";
  fs.writeFileSync(patchPath(home, "web"), broken);
  assert.throws(() => profile.apply(MODELS, ORIGIN, home), /web\/cordis\.patch\.yml has YAML errors/);
  assert.equal(fs.readFileSync(patchPath(home, "web"), "utf8"), broken);
  assert.equal(fs.existsSync(patchPath(home, "desktop")), false);
});

test("every profile is synced", (t) => {
  const home = tempHome(t, ["desktop", "web"]);
  const result = profile.apply(MODELS, ORIGIN, home);
  assert.deepEqual(result.profiles.map((item) => item.profile).sort(), ["desktop", "web"]);
  assert.deepEqual(ids(providers(home, "web")["dshgate-lanes"]), ["lane-main"]);
});

test("a machine without DeepSeek Harness profiles is reported, not written to", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshgate-profile-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.throws(() => profile.apply(MODELS, ORIGIN, home), /profiles were not found/);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("removing takes out only the gateway's routes and leaves the file as it was", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(patchPath(home), EXISTING);
  profile.apply(MODELS, ORIGIN, home);
  const results = profile.remove(home);
  assert.deepEqual(results[0].removed.sort(), ["dshgate-claude", "dshgate-compat", "dshgate-lanes", "dshgate-openai"]);
  assert.equal(fs.readFileSync(patchPath(home), "utf8"), EXISTING);
});

const WITHOUT_ENTRY = "# Your patch layer.\n- id: ui-chat\n  config:\n    transcriptView: standard\n";

test("removing also takes out the plugin entry that applying added", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(patchPath(home), WITHOUT_ENTRY);
  profile.apply(MODELS, ORIGIN, home);
  profile.remove(home);
  assert.equal(fs.readFileSync(patchPath(home), "utf8"), WITHOUT_ENTRY);
});

test("a plugin entry the user wrote is kept when its routes are removed", (t) => {
  const home = tempHome(t);
  const own = "- id: llm-pi-ai\n  name: \"@deepseek-ai/dsh-llm-pi-ai\"\n  config:\n    providers: {}\n";
  fs.writeFileSync(patchPath(home), own);
  profile.apply(MODELS, ORIGIN, home);
  profile.remove(home);
  assert.equal(fs.readFileSync(patchPath(home), "utf8"), own);
});

test("an entry that applying added is kept while other routes are in it", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(patchPath(home), WITHOUT_ENTRY);
  profile.apply(MODELS, ORIGIN, home);
  const doc = YAML.parseDocument(fs.readFileSync(patchPath(home), "utf8"));
  doc.contents.items[1].setIn(["config", "providers", "my-gateway"], { api: "openai-completions", baseURL: "https://gateway.example/v1", models: [{ id: "my-model" }] });
  fs.writeFileSync(patchPath(home), doc.toString());
  profile.remove(home);
  assert.deepEqual(Object.keys(providers(home)), ["my-gateway"]);
});

test("a profile that cannot be parsed stops a removal before anything is written", (t) => {
  const home = tempHome(t, ["desktop", "web"]);
  profile.apply(MODELS, ORIGIN, home);
  const applied = fs.readFileSync(patchPath(home, "desktop"), "utf8");
  fs.writeFileSync(patchPath(home, "web"), "- id: llm-pi-ai\n  config: [unclosed\n");
  assert.throws(() => profile.remove(home), /web\/cordis\.patch\.yml has YAML errors/);
  assert.equal(fs.readFileSync(patchPath(home, "desktop"), "utf8"), applied);
});

test("a dry-run removal reports the routes and writes nothing", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(patchPath(home), EXISTING);
  profile.apply(MODELS, ORIGIN, home);
  const applied = fs.readFileSync(patchPath(home), "utf8");
  const before = backups(home).length;
  const results = profile.remove(home, { dryRun: true });
  assert.equal(results[0].removed.length, 4);
  assert.equal(results[0].changed, true);
  assert.equal(fs.readFileSync(patchPath(home), "utf8"), applied);
  assert.equal(backups(home).length, before);
});

test("two changes in quick succession each keep their own backup", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(patchPath(home), EXISTING);
  profile.apply(MODELS, ORIGIN, home);
  const afterFirst = fs.readFileSync(patchPath(home), "utf8");
  profile.apply([...MODELS, ...API_KEY], ORIGIN, home);
  const saved = backups(home).map((file) => fs.readFileSync(path.join(home, "profiles", "desktop", file), "utf8"));
  assert.equal(saved.length, 2);
  assert.ok(saved.includes(EXISTING));
  assert.ok(saved.includes(afterFirst));
});

test("a credentials file of an unexpected shape is left alone and reported", (t) => {
  const home = tempHome(t);
  const file = path.join(home, ".credentials.yaml");
  const odd = "- something\n- else\n";
  fs.writeFileSync(file, odd);
  const result = profile.apply(MODELS, ORIGIN, home);
  assert.equal(result.credential.created, false);
  assert.match(result.credential.reason, /not in the expected form/);
  assert.equal(fs.readFileSync(file, "utf8"), odd);
});

test("the state reports whether the routes point at this gateway", (t) => {
  const home = tempHome(t);
  assert.equal(profile.state(ORIGIN, home).applied, false);
  profile.apply(MODELS, ORIGIN, home);
  assert.equal(profile.state(ORIGIN, home).applied, true);
  // The gateway moved to another port: the routes are stale.
  assert.equal(profile.state("http://127.0.0.1:9000", home).applied, false);
});
