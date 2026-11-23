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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-profile-"));
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
  assert.deepEqual(ids(routes["dshproxy-lanes"]), ["lane-main"]);
  assert.deepEqual(ids(routes["dshproxy-claude"]), ["claude-fable-5-2"]);
  assert.deepEqual(ids(routes["dshproxy-openai"]), ["gpt-6-astra"]);
  assert.deepEqual(ids(routes["dshproxy-compat"]), ["gemini-4-carbon-high", "mistral/codestral-2508"]);
  assert.equal(routes["dshproxy-lanes"].api, "anthropic-messages");
  assert.equal(routes["dshproxy-lanes"].baseURL, "http://127.0.0.1:8417");
  assert.equal(routes["dshproxy-claude"].baseURL, "http://127.0.0.1:8417");
  assert.equal(routes["dshproxy-openai"].api, "openai-responses");
  assert.equal(routes["dshproxy-openai"].baseURL, "http://127.0.0.1:8417/v1");
  assert.equal(routes["dshproxy-compat"].api, "openai-completions");
  assert.equal(routes["dshproxy-compat"].baseURL, "http://127.0.0.1:8417/v1");
});

test("a model entry declares its sizes, inputs and reasoning levels", (t) => {
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home);
  const routes = providers(home);
  assert.deepEqual(routes["dshproxy-compat"].models[0], {
    id: "gemini-4-carbon-high",
    name: "gemini-4-carbon-high",
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    reasoningEfforts: { high: "high" }
  });
  // A model without reasoning levels is declared as non-reasoning.
  assert.equal(routes["dshproxy-compat"].models[1].reasoningEfforts, false);
});

test("the routes refer to a credential that exists", (t) => {
  const home = tempHome(t);
  const result = profile.apply(MODELS, ORIGIN, home);
  assert.equal(result.credential.created, true);
  const ref = providers(home)["dshproxy-claude"].apiKeyEnv;
  const credentials = YAML.parse(fs.readFileSync(path.join(home, ".credentials.yaml"), "utf8"));
  assert.equal(typeof credentials.refs[ref], "string");
  assert.ok(credentials.refs[ref].length > 0);
});

test("credentials that are already saved are kept", (t) => {
  const home = tempHome(t);
  const file = path.join(home, ".credentials.yaml");
  fs.writeFileSync(file, "version: 1\nrecords:\n  some/record:\n    kind: api-key\nrefs:\n  DEEPSEEK_API_KEY: existing-value\n  DSHPROXY_API_KEY: chosen-by-user\n");
  const result = profile.apply(MODELS, ORIGIN, home);
  assert.equal(result.credential.created, false);
  assert.deepEqual(YAML.parse(fs.readFileSync(file, "utf8")), {
    version: 1,
    records: { "some/record": { kind: "api-key" } },
    refs: { DEEPSEEK_API_KEY: "existing-value", DSHPROXY_API_KEY: "chosen-by-user" }
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
  assert.deepEqual(ids(doc[1].config.providers["dshproxy-lanes"]), ["lane-main"]);
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
  const gemini = doc.find((item) => item.id === "llm-pi-ai").config.providers["dshproxy-compat"].models[0];
  gemini.input = ["text"];
  gemini.compat = { supportsDeveloperRole: false };
  fs.writeFileSync(patchPath(home), YAML.stringify(doc));

  profile.apply(MODELS, ORIGIN, home);

  const after = providers(home)["dshproxy-compat"].models[0];
  assert.deepEqual(after.input, ["text"]);
  assert.deepEqual(after.compat, { supportsDeveloperRole: false });
});

test("a model that is no longer offered is removed", (t) => {
  const home = tempHome(t);
  profile.apply([...MODELS, ...API_KEY], ORIGIN, home);
  profile.apply(MODELS, ORIGIN, home);
  assert.deepEqual(ids(providers(home)["dshproxy-compat"]), ["gemini-4-carbon-high", "mistral/codestral-2508"]);
});

test("models of a provider whose saved key cannot be read are kept", (t) => {
  const home = tempHome(t);
  profile.apply([...MODELS, ...API_KEY], ORIGIN, home);
  // Qwen was removed by the user; DeepSeek's key is unreadable right now.
  const result = profile.apply(MODELS, ORIGIN, home, { keepModelPrefixes: ["deepseek"] });
  assert.deepEqual(ids(providers(home)["dshproxy-compat"]), ["gemini-4-carbon-high", "mistral/codestral-2508", "deepseek/deepseek-v4-pro"]);
  assert.deepEqual(result.profiles[0].kept, ["deepseek/deepseek-v4-pro"]);
});

test("a route with no models left is removed", (t) => {
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home);
  profile.apply(MODELS.filter((item) => item.api !== "openai"), ORIGIN, home);
  assert.equal(providers(home)["dshproxy-openai"], undefined);
});

test("a dry run reports the change and writes nothing", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(patchPath(home), EXISTING);
  const result = profile.apply(MODELS, ORIGIN, home, { dryRun: true });
  assert.equal(result.profiles[0].changed, true);
  assert.deepEqual(result.profiles[0].routes, { "dshproxy-lanes": 1, "dshproxy-claude": 1, "dshproxy-openai": 1, "dshproxy-compat": 2 });
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
  assert.deepEqual(ids(providers(home, "web")["dshproxy-lanes"]), ["lane-main"]);
});

test("a machine without DeepSeek Harness profiles is reported, not written to", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-profile-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.throws(() => profile.apply(MODELS, ORIGIN, home), /profiles were not found/);
  assert.deepEqual(fs.readdirSync(home), []);
});

test("removing takes out only the gateway's routes and leaves the file as it was", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(patchPath(home), EXISTING);
  profile.apply(MODELS, ORIGIN, home);
  const results = profile.remove(home);
  assert.deepEqual(results[0].removed.sort(), ["dshproxy-claude", "dshproxy-compat", "dshproxy-lanes", "dshproxy-openai"]);
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

test("a sync touches only the profiles that already have DSHProxy routes", (t) => {
  const home = tempHome(t, ["desktop", "web"]);
  fs.writeFileSync(patchPath(home, "web"), EXISTING);
  profile.apply(MODELS, ORIGIN, home, { only: ["desktop"] });
  const before = fs.readFileSync(patchPath(home, "web"), "utf8");
  const result = profile.apply([...MODELS, model("claude-opus-5", "claude")], ORIGIN, home, { onlyApplied: true });
  assert.deepEqual(result.profiles.map((item) => item.profile), ["desktop"]);
  assert.ok(ids(providers(home)["dshproxy-claude"]).includes("claude-opus-5"));
  assert.equal(fs.readFileSync(patchPath(home, "web"), "utf8"), before);
  assert.equal(backups(home, "web").length, 0);
});

test("a sync with no applied profile writes nothing, not even the credential reference", (t) => {
  const home = tempHome(t, ["desktop"]);
  fs.writeFileSync(patchPath(home), EXISTING);
  const result = profile.apply(MODELS, ORIGIN, home, { onlyApplied: true });
  assert.deepEqual(result.profiles, []);
  assert.equal(result.credential.created, false);
  assert.equal(fs.readFileSync(patchPath(home), "utf8"), EXISTING);
});

// Profiles written before the rename carry the old route names.
function oldRouteProfile(home, name = "desktop") {
  profile.apply(MODELS, ORIGIN, home, { only: [name] });
  const file = patchPath(home, name);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/dshproxy-/g, "dshgate-").replace(/DSHPROXY_API_KEY/g, "DSHGATE_API_KEY").replace(/added by dshproxy/g, "added by dshgate"));
}

test("routes from before the rename are replaced, not left beside the new ones", (t) => {
  const home = tempHome(t);
  oldRouteProfile(home);
  profile.apply(MODELS, ORIGIN, home);
  const keys = Object.keys(providers(home));
  assert.deepEqual(keys.filter((key) => key.startsWith("dshgate-")), []);
  assert.ok(keys.includes("dshproxy-lanes"));
  assert.equal(providers(home)["dshproxy-lanes"].apiKeyEnv, "DSHPROXY_API_KEY");
});

test("an automatic sync counts a profile with old route names as applied", (t) => {
  const home = tempHome(t, ["desktop", "web"]);
  oldRouteProfile(home, "desktop");
  const result = profile.apply(MODELS, ORIGIN, home, { onlyApplied: true });
  assert.deepEqual(result.profiles.map((item) => item.profile), ["desktop"]);
  assert.ok(providers(home)["dshproxy-claude"]);
});

test("removing also takes out routes from before the rename", (t) => {
  const home = tempHome(t);
  oldRouteProfile(home);
  profile.remove(home);
  const text = fs.readFileSync(patchPath(home), "utf8");
  assert.doesNotMatch(text, /dshgate-|dshproxy-/);
});

test("every route keeps the retained image count under the many-image limit", (t) => {
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home);
  const routes = providers(home);
  for (const key of ["dshproxy-lanes", "dshproxy-claude", "dshproxy-openai", "dshproxy-compat"]) {
    assert.equal(routes[key].maxRequestImages, profile.MAX_REQUEST_IMAGES, `${key} lacks the image cap`);
    assert.equal(routes[key].maxRequestImageBytes, profile.MAX_REQUEST_IMAGE_BYTES, `${key} lacks the image payload cap`);
  }
  assert.ok(profile.MAX_REQUEST_IMAGES < 20, "the cap must stay under the many-image threshold");
});

test("verify says a freshly applied profile is ready", (t) => {
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home, { lanes: { main: ["gemini-4-carbon-high"] } });
  const report = profile.verify({ origin: ORIGIN, lanes: { main: ["gemini-4-carbon-high"] }, models: MODELS.map((entry) => ({ id: entry.id, api: entry.api })), home });
  assert.deepEqual(report.profiles[0].problems, []);
  assert.equal(report.ok, true);
  assert.equal(report.profiles[0].profile, "desktop");
  assert.deepEqual(report.credential, []);
});

test("verify reports a profile that would break the harness", (t) => {
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home, { lanes: { main: ["gemini-4-carbon-high"] } });
  // Simulate drift: a route moved to another port, a model no longer offered,
  // and the default model removed.
  const file = patchPath(home);
  let text = fs.readFileSync(file, "utf8");
  text = text.replace(`baseURL: ${ORIGIN}`, "baseURL: http://127.0.0.1:9999");
  text = text.replace("- id: agent-default-model", "- id: something-else");
  fs.writeFileSync(file, text);
  const report = profile.verify({ origin: ORIGIN, lanes: { main: ["gemini-4-carbon-high"] }, models: MODELS.map((entry) => ({ id: entry.id, api: entry.api })), home });
  assert.equal(report.ok, false);
  const problems = report.profiles[0].problems.join("\n");
  assert.match(problems, /baseURL is http:\/\/127\.0\.0\.1:9999/);
  assert.match(problems, /no agent-default-model entry/);
});

test("apply repairs a missing default model", (t) => {
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home, { lanes: { main: ["gemini-4-carbon-high"] } });
  const file = patchPath(home);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/- id: agent-default-model[\s\S]*?model: lane-[a-z-]+\n/, ""));
  const repaired = profile.apply(MODELS, ORIGIN, home, { lanes: { main: ["gemini-4-carbon-high"] } });
  assert.equal(repaired.profiles[0].repairedDefault, true);
  const report = profile.verify({ origin: ORIGIN, lanes: { main: ["gemini-4-carbon-high"] }, models: MODELS.map((entry) => ({ id: entry.id, api: entry.api })), home });
  assert.deepEqual(report.profiles[0].problems, []);
});

test("verify reports a DroidProxy provider left behind", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(patchPath(home), [
    "- id: llm-pi-ai",
    "  name: \"@deepseek-ai/dsh-llm-pi-ai\"",
    "  config:",
    "    providers:",
    "      droidproxy-claude:",
    "        baseURL: http://127.0.0.1:8317",
    ""
  ].join("\n"));
  const report = profile.verify({ origin: ORIGIN, lanes: {}, models: [], home });
  assert.equal(report.ok, false);
  assert.match(report.profiles[0].problems.join("\n"), /DroidProxy provider \(droidproxy-claude\)/);
});

// What broke the `reviewer` tool on 2026-11-18: it was pinned to a route that
// had gone when its account was suspended, and verify still said "ready".
const TOOL_WIRING = (reviewer, allowed) => [
  "- id: subagent-model-selection-settings",
  "  name: \"@deepseek-ai/dsh-subagent-model-selection\"",
  "  config:",
  "    allowedModels:",
  ...allowed.map((entry) => `      - { provider: ${entry[0]}, model: ${entry[1]} }`),
  "- insert:",
  "    - id: tool-scout",
  "      name: \"@deepseek-ai/dsh-tool-subagent\"",
  "      config:",
  "        toolName: scout",
  "        agentOptions:",
  "          provider: dshproxy-lanes",
  "          model: lane-main",
  "    - id: tool-reviewer",
  "      name: \"@deepseek-ai/dsh-tool-subagent\"",
  "      config:",
  "        toolName: reviewer",
  "        agentOptions:",
  `          provider: ${reviewer[0]}`,
  `          model: ${reviewer[1]}`,
  ""
].join("\n");

function verifyWithWiring(t, reviewer, allowed) {
  const home = tempHome(t);
  const lanes = { main: ["gemini-4-carbon-high"] };
  profile.apply(MODELS, ORIGIN, home, { lanes });
  fs.appendFileSync(patchPath(home), TOOL_WIRING(reviewer, allowed));
  return profile.verify({ origin: ORIGIN, lanes, models: MODELS.map((entry) => ({ id: entry.id, api: entry.api })), home });
}

test("verify accepts tools and allowed models that point at routes the profile has", (t) => {
  const report = verifyWithWiring(t, ["dshproxy-lanes", "lane-main"], [["dshproxy-lanes", "lane-main"], ["dshproxy-compat", "gemini-4-carbon-high"], ["some-other-gateway", "any-model"]]);
  assert.deepEqual(report.profiles[0].problems, []);
  assert.equal(report.ok, true);
});

test("verify reports a tool pinned to a model its route does not list", (t) => {
  const report = verifyWithWiring(t, ["dshproxy-compat", "gemini-9-gone"], [["dshproxy-lanes", "lane-main"]]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.profiles[0].problems, ["tool-reviewer names dshproxy-compat/gemini-9-gone, which this profile does not define (the tool would fail)"]);
});

test("verify reports a tool or an allowed model on a route that is gone", (t) => {
  const report = verifyWithWiring(t, ["dshproxy-vanished", "gemini-4-carbon-high"], [["dshproxy-lanes", "lane-main"], ["dshproxy-lanes", "lane-nowhere"]]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.profiles[0].problems, [
    "subagent-model-selection-settings names dshproxy-lanes/lane-nowhere, which this profile does not define (the tool would fail)",
    "tool-reviewer names dshproxy-vanished/gemini-4-carbon-high, which this profile does not define (the tool would fail)"
  ]);
});

// 249 backups had piled up in two profiles by 2026-11-18, with a temporary
// file left by an interrupted write.
test("old backups and stale temporary files of this program are cleared, others are kept", (t) => {
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home);
  const dir = path.dirname(patchPath(home));
  const own = Array.from({ length: 14 }, (_, index) => `cordis.patch.yml.dshproxy-200101${String(index + 1).padStart(2, "0")}T120000000.bak`);
  const foreign = ["cordis.patch.yml.dshgate-20261101T120000000.bak", "cordis.patch.yml.pre-image-input-20261101.bak", "cordis.patch.yml.2026-11-01T12-00-00-000Z.bak", "notes.dshproxy-20261101T120000000.bak", "cordis.patch.yml.dshproxy-notes.bak", "cordis.patch.yml.dshproxy-20010101.bak"];
  for (const name of [...own, ...foreign]) fs.writeFileSync(path.join(dir, name), "old");
  const staleTmp = path.join(dir, "cordis.patch.yml.dshproxy-41836.tmp");
  const freshTmp = path.join(dir, "cordis.patch.yml.dshproxy-777.tmp");
  const foreignTmp = path.join(dir, "cordis.patch.yml.other-1.tmp");
  for (const file of [staleTmp, freshTmp, foreignTmp]) fs.writeFileSync(file, "half");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(staleTmp, twoHoursAgo, twoHoursAgo);
  fs.utimesSync(foreignTmp, twoHoursAgo, twoHoursAgo);

  // A change writes one more backup, then clears up.
  profile.apply([...MODELS, ...API_KEY], ORIGIN, home);
  const left = fs.readdirSync(dir);
  const ownLeft = left.filter((name) => /^cordis\.patch\.yml\.dshproxy-\d{8}T\d{9}(-\d+)?\.bak$/.test(name)).sort();
  assert.equal(ownLeft.length, 10);
  // The newest are kept: the one just written and the nine latest of the old ones.
  assert.deepEqual(ownLeft.slice(0, 9), own.slice(5));
  assert.equal(own.includes(ownLeft[9]), false);
  for (const name of foreign) assert.ok(left.includes(name), `${name} was removed`);
  assert.equal(fs.existsSync(staleTmp), false);
  assert.equal(fs.existsSync(freshTmp), true);
  assert.equal(fs.existsSync(foreignTmp), true);
});

test("a default model that is gone is reported once, by its own check", (t) => {
  const home = tempHome(t);
  const lanes = { main: ["gemini-4-carbon-high"] };
  profile.apply(MODELS, ORIGIN, home, { lanes });
  const file = patchPath(home);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/(- id: agent-default-model[\s\S]*?model: )lane-[a-z-]+/, "$1lane-nowhere"));
  const report = profile.verify({ origin: ORIGIN, lanes, models: MODELS.map((entry) => ({ id: entry.id, api: entry.api })), home });
  assert.deepEqual(report.profiles[0].problems, ["agent-default-model names model lane-nowhere, which is not offered"]);
});

// Windows refuses to replace a read-only file, which is how a write can fail
// half-way: the new text is already in a temporary file next to the profile.
test("a profile that cannot be replaced is left as it was, with no temporary file beside it", { skip: process.platform === "darwin" ? "a Mac replaces a read-only file; the same behaviour is tested with a locked file in the next test" : false }, (t) => {
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home);
  const file = patchPath(home);
  const before = fs.readFileSync(file, "utf8");
  fs.chmodSync(file, 0o444);
  try {
    assert.throws(() => profile.apply([...MODELS, ...API_KEY], ORIGIN, home), /EPERM|EACCES/);
  } finally {
    // So the temporary folder can be removed afterwards.
    fs.chmodSync(file, 0o666);
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")), []);
});

// On a Mac a read-only file is replaced all the same; a locked one (the
// "user immutable" flag) is not, which is the same failure half-way.
test("on macOS, a profile that cannot be replaced is left as it was, with no temporary file beside it", { skip: process.platform === "darwin" ? false : "macOS only; Windows has the test above" }, (t) => {
  const { execFileSync } = require("child_process");
  const home = tempHome(t);
  profile.apply(MODELS, ORIGIN, home);
  const file = patchPath(home);
  const before = fs.readFileSync(file, "utf8");
  execFileSync("/usr/bin/chflags", ["uchg", file]);
  try {
    assert.throws(() => profile.apply([...MODELS, ...API_KEY], ORIGIN, home), /EPERM|EACCES/);
  } finally {
    // So the temporary folder can be removed afterwards.
    execFileSync("/usr/bin/chflags", ["nouchg", file]);
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")), []);
});
