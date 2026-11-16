const test = require("node:test");
const assert = require("node:assert/strict");

const catalog = require("../src/catalog");
const { availability, createResolver, describe } = require("../src/lanes");
const settings = require("../src/settings");

test("every default ladder names only models the gateway knows", () => {
  for (const [lane, ladder] of Object.entries(settings.DEFAULT_LANES)) {
    for (const id of ladder) assert.ok(catalog.findModel(id), `${lane}: ${id}`);
  }
});

test("the default reviewer ladder never reviews with the GPT family", () => {
  assert.deepEqual(settings.DEFAULT_LANES.reviewer.filter((id) => id.startsWith("gpt-")), []);
});

test("a lane is sized for the smallest model on its ladder", () => {
  const [lane] = catalog.laneModels({ main: ["gpt-6-astra", "claude-fable-5-2", "gemini-4-carbon-high"] });
  assert.equal(lane.id, "lane-main");
  // GPT has the smallest context window, Gemini the smallest output.
  assert.equal(lane.contextWindow, 272000);
  assert.equal(lane.maxTokens, 65536);
});

test("an API-key model is found in whichever region lists it", () => {
  assert.equal(catalog.findModel("qwen/glm-5.3").name, "GLM-5.3 (Qwen Token Plan)");
  assert.equal(catalog.findModel("qwen/qwen3.8-max").contextWindow, 991808);
  assert.equal(catalog.findModel("qwen/unknown"), null);
  assert.equal(catalog.findModel("nobody/model"), null);
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
  assert.equal(clean.requestRetry, 3);
  assert.equal(clean.cooldownMinutes, 10);
  assert.deepEqual(clean.lanes, { ok: ["gpt-6-astra"] });
});

test("a forced model gets its lane siblings, then its account siblings, as fallbacks", () => {
  const lanes = { google: ["gemini-3.8-flash-high", "gemini-4-carbon-high"] };
  const resolve = createResolver({ lanes: () => lanes, isAvailable: () => true, siblings: (id) => (id === "claude-opus-5" ? ["claude-sonnet-5-5", "claude-opus-5"] : []) });
  assert.deepEqual(resolve("gemini-4-carbon-high"), { lane: null, ladder: ["gemini-4-carbon-high"], fallbacks: ["gemini-3.8-flash-high"] });
  assert.deepEqual(resolve("claude-opus-5"), { lane: null, ladder: ["claude-opus-5"], fallbacks: ["claude-sonnet-5-5"] });
  assert.deepEqual(resolve("gemini-3-flash"), { lane: null, ladder: ["gemini-3-flash"] });
});

test("a forced model's fallbacks skip models with no account", () => {
  const lanes = { google: ["gemini-3.8-flash-high", "gemini-4-carbon-high", "gemini-4-hydrogen-xhigh"] };
  const resolve = createResolver({ lanes: () => lanes, isAvailable: (id) => id !== "gemini-4-hydrogen-xhigh" });
  assert.deepEqual(resolve("gemini-3.8-flash-high").fallbacks, ["gemini-4-carbon-high"]);
});

test("a Claude pick is answered by Claude before a Gemini lane sibling", () => {
  const lanes = { main: ["gpt-6-astra", "claude-fable-5-2", "gemini-4-carbon-high"] };
  const account = (id) => (id.startsWith("claude-") ? "claude" : id.startsWith("gemini-") ? "antigravity" : "codex");
  const resolve = createResolver({
    lanes: () => lanes,
    isAvailable: () => true,
    siblings: (id) => (id === "claude-fable-5-2" ? ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5"] : []),
    accountOf: account
  });
  assert.deepEqual(resolve("claude-fable-5-2").fallbacks, ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-astra", "gemini-4-carbon-high"]);
});

test("a Gemini pick keeps its Google lane order first", () => {
  const lanes = { google: ["gemini-3.8-flash-high", "gemini-4-carbon-high", "gemini-4-hydrogen-xhigh"] };
  const resolve = createResolver({
    lanes: () => lanes,
    isAvailable: () => true,
    siblings: (id) => (id === "gemini-3.8-flash-high" ? ["gemini-3.8-flash-high", "gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", "ag-c55o-high"] : []),
    accountOf: () => "antigravity"
  });
  assert.deepEqual(resolve("gemini-3.8-flash-high").fallbacks, ["gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", "ag-c55o-high"]);
});

test("a Claude-via-Google pick prefers its own family on that account", () => {
  const resolve = createResolver({
    lanes: () => ({}),
    isAvailable: () => true,
    siblings: (id) => (id === "ag-c55o-high" ? ["ag-c55o-high", "gemini-4-carbon-high", "ag-c55s-high"] : []),
    accountOf: () => "antigravity"
  });
  assert.deepEqual(resolve("ag-c55o-high").fallbacks, ["ag-c55s-high", "gemini-4-carbon-high"]);
});
