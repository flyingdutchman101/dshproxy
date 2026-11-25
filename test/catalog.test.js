const test = require("node:test");
const assert = require("node:assert/strict");

const catalog = require("../src/catalog");
const { availability, createResolver, describe } = require("../src/lanes");
const settings = require("../src/settings");
const { suggestions } = require("../src/models");

test("every default ladder names only models the gateway knows", () => {
  for (const [lane, ladder] of Object.entries(settings.DEFAULT_LANES)) {
    for (const id of ladder) assert.ok(catalog.findModel(id), `${lane}: ${id}`);
  }
});

test("the default reviewer ladder never reviews with the GPT family", () => {
  assert.deepEqual(settings.DEFAULT_LANES.reviewer.filter((id) => id.startsWith("gpt-")), []);
});

test("a lane offers the largest context window on its ladder, and the smallest output budget", () => {
  const [lane] = catalog.laneModels({ main: ["gpt-6-astra", "claude-fable-5-2", "gemini-4-carbon-high"] });
  assert.equal(lane.id, "lane-main");
  // The window is the largest on the ladder: a conversation is never cut short
  // because of a smaller rung that failover would have passed over. GPT has the
  // smallest window (272,000), Claude the largest (1,000,000); Gemini the
  // smallest output budget (65,536), and an output budget must hold on every rung.
  assert.equal(lane.contextWindow, 1000000);
  assert.equal(lane.maxTokens, 65536);
});

test("a lane whose rungs are all unknown keeps the default window", () => {
  const [lane] = catalog.laneModels({ main: [] });
  assert.equal(lane.contextWindow, 200000);
  assert.equal(lane.maxTokens, 32000);
});

test("an API-key model is found in whichever region lists it", () => {
  assert.equal(catalog.findModel("qwen/glm-5.3").name, "GLM-5.3 (Qwen Token Plan)");
  assert.equal(catalog.findModel("qwen/qwen3.8-max").contextWindow, 991808);
  assert.equal(catalog.findModel("qwen/unknown"), null);
  assert.equal(catalog.findModel("nobody/model"), null);
});

test("Qwen4 Max is offered on the Token Plan and on the pay-as-you-go hosts, sized for a request that thinks", () => {
  const model = catalog.findModel("qwen/qwen4-max");
  assert.equal(model.name, "Qwen4 Max");
  // The most input the model takes with thinking on, and its longest answer without.
  assert.equal(model.contextWindow, 983616);
  assert.equal(model.maxTokens, 131072);
  for (const region of ["tokenplan", "singapore", "china"]) {
    const isAvailable = availability({ accounts: new Set(), providers: { qwen: { region } } });
    assert.equal(isAvailable("qwen/qwen4-max"), true, region);
  }
  // The model it joins is still there.
  assert.equal(catalog.findModel("qwen/qwen3.8-max").name, "Qwen3.8 Max");
});

test("a Token Plan key is placed on the Token Plan host", () => {
  assert.equal(catalog.regionForKey("qwen", "sk-sp-abc", "singapore"), "tokenplan");
  assert.equal(catalog.regionForKey("qwen", "sk-ws-abc", "tokenplan"), "singapore");
  assert.equal(catalog.regionForKey("qwen", "sk-ws-abc", "china"), "china");
  assert.equal(catalog.regionForKey("deepseek", "sk-abc", "nowhere"), "international");
});

const LANES = { main: ["gpt-6-astra", "claude-fable-5-2", "deepseek/deepseek-v4-pro"] };

test("a lane resolves to the rungs that have an account or key", () => {
  const isAvailable = availability({ accounts: new Set(["claude"]), providers: { deepseek: { region: "international" } } });
  const resolve = createResolver({ lanes: () => LANES, isAvailable });
  assert.deepEqual(resolve("lane-main"), { lane: "main", ladder: ["claude-fable-5-2", "deepseek/deepseek-v4-pro"] });
});

test("a lane with nothing signed in resolves to no rungs", () => {
  const resolve = createResolver({ lanes: () => LANES, isAvailable: availability({ accounts: new Set(), providers: {} }) });
  assert.deepEqual(resolve("lane-main"), { lane: "main", ladder: [] });
});

test("a model the configured region does not serve is not available", () => {
  // Qwen pay-as-you-go does not list GLM; only the Token Plan does.
  const isAvailable = availability({ accounts: new Set(), providers: { qwen: { region: "singapore" } } });
  assert.equal(isAvailable("qwen/qwen3.8-max"), true);
  assert.equal(isAvailable("qwen/glm-5.3"), false);
});

test("any other model ID is tried as it is", () => {
  const resolve = createResolver({ lanes: () => LANES, isAvailable: () => false });
  assert.deepEqual(resolve("claude-opus-5-5"), { lane: null, ladder: ["claude-opus-5-5"] });
  assert.deepEqual(resolve("lane-unknown"), { lane: null, ladder: ["lane-unknown"] });
});

test("a model served under another name is described with that name", () => {
  assert.deepEqual(describe("ag-c55o-high"), { efforts: ["high"], upstream: "claude-opus-5-5-high" });
  assert.deepEqual(describe("gpt-6-astra"), { efforts: ["low", "medium", "high", "xhigh", "max"], upstream: null });
  assert.deepEqual(describe("something-new"), {});
});

test("the gateway only ever listens on this machine", () => {
  assert.equal(settings.sanitize({ host: "0.0.0.0" }).host, "127.0.0.1");
  assert.equal(settings.sanitize({ host: "192.168.1.20" }).host, "127.0.0.1");
  assert.equal(settings.sanitize({ host: "localhost" }).host, "localhost");
  assert.equal(settings.origin(settings.sanitize({ host: "::1", port: 9001 })), "http://[::1]:9001");
});

test("the gateway and its backend never share a port", () => {
  const clean = settings.sanitize({ port: 9000, backendPort: 9000 });
  assert.equal(clean.port, 9000);
  assert.notEqual(clean.backendPort, 9000);
});

test("invalid settings fall back to the defaults", () => {
  const clean = settings.sanitize({ port: "abc", requestRetry: 99, cooldownMinutes: 0, lanes: { "Bad Name": ["x"], ok: ["gpt-6-astra", "gpt-6-astra", ""] } });
  assert.equal(clean.port, 8417);
  // The backend retry count is no longer a setting: a stored value is dropped.
  assert.equal("requestRetry" in clean, false);
  assert.equal(clean.cooldownMinutes, 10);
  assert.deepEqual(clean.lanes, { ok: ["gpt-6-astra"] });
});





test("a forced model resolves to itself only", () => {
  const resolve = createResolver({ lanes: () => ({ main: ["gpt-6-astra", "claude-opus-5-5"] }), isAvailable: () => true });
  assert.deepEqual(resolve("claude-opus-5-5"), { lane: null, ladder: ["claude-opus-5-5"] });
});

// Released upstream after the hand list was written (seen in the backend's catalog
// on 25 Nov): GPT 6.2 on the ChatGPT plan. Offered, and proposed to the lanes that
// still name the older version — the user decides.
test("GPT 6.2 is offered and proposed to lanes that still name the older version", () => {
  const models = catalog.subscriptionModels();
  assert.ok(models.find((model) => model.id === "gpt-6.2-astra"), "gpt-6.2-astra missing");
  assert.ok(models.find((model) => model.id === "gpt-6.2-sol"), "gpt-6.2-sol missing");
  const proposed = suggestions({ main: ["gpt-6-astra"], scout: ["gpt-6.1-sol"] }, models);
  assert.deepEqual(proposed.map((item) => [item.from, item.to]).sort(), [["gpt-6-astra", "gpt-6.2-astra"], ["gpt-6.1-sol", "gpt-6.2-sol"]]);
});
