const test = require("node:test");
const assert = require("node:assert/strict");

const { parseCatalog, buildModels, suggestions, isCurrent } = require("../src/models");

// Entries in the shape of CLIProxyAPI's catalog (models.router-for.me), 2026-11-16.
const CATALOG = {
  claude: [
    { id: "claude-fable-5-2", created: 1794250800, display_name: "Claude Fable 5.2", context_length: 1000000, max_completion_tokens: 128000, thinking: { levels: ["low", "medium", "high", "xhigh", "max"] }, supportedInputModalities: ["text", "image"], supportedOutputModalities: ["text"] },
    { id: "claude-fable-5-3", created: 1795000000, display_name: "Claude Fable 5.3", context_length: 1000000, max_completion_tokens: 128000, thinking: { levels: ["low", "medium", "high", "xhigh", "max"] }, supportedInputModalities: ["text", "image"], supportedOutputModalities: ["text"] },
    { id: "claude-opus-5", created: 1784038800, display_name: "Claude Opus 5", context_length: 1000000, max_completion_tokens: 128000, thinking: { levels: ["low", "high"] } },
    { id: "claude-3-7-sonnet-20250219", created: 1708300800, display_name: "Claude 3.7 Sonnet", context_length: 200000, max_completion_tokens: 64000 }
  ],
  "codex-team": [
    { id: "gpt-6.1-terra", created: 1793000000, display_name: "GPT 6.1 Terra", context_length: 500000, max_completion_tokens: 128000, thinking: { levels: ["low", "medium", "high", "xhigh", "max"] } },
    { id: "gpt-6-sol", created: 1790000000, display_name: "GPT 6 Sol", context_length: 272000, max_completion_tokens: 128000, thinking: { levels: ["low", "medium", "high"] } },
    { id: "gpt-image-2.6", display_name: "GPT Image 2.6", supportedOutputModalities: ["image"] }
  ],
  "codex-pro": [
    { id: "gpt-6.1-terra", created: 1793000000, display_name: "GPT 6.1 Terra", context_length: 900000, max_completion_tokens: 128000 }
  ],
  antigravity: [
    { id: "gemini-4-carbon-high", display_name: "Gemini 4 Carbon", context_length: 1048576, max_completion_tokens: 1048576, thinking: { levels: ["low", "medium", "high"] }, supportedInputModalities: ["text", "image", "audio", "video"] },
    { id: "gemini-4-hydrogen-xhigh", display_name: "Gemini 4 Hydrogen", context_length: 1048576, max_completion_tokens: 65536, thinking: { levels: ["low", "high"] } },
    { id: "claude-sonnet-5-5-high", display_name: "Claude Sonnet 5.5 (High)", context_length: 1000000, max_completion_tokens: 128000, thinking: { levels: ["low", "medium", "high"] } },
    { id: "gemini-3.1-flash-image", display_name: "Gemini 3.1 Flash Image", supportedOutputModalities: ["text", "image"] }
  ]
};

test("the catalog is read per account type, with sizes and reasoning levels", () => {
  const catalog = parseCatalog(CATALOG);
  const fable = catalog.get("claude:claude-fable-5-3");
  assert.deepEqual(fable, { id: "claude-fable-5-3", account: "claude", name: "Claude Fable 5.3", contextWindow: 1000000, maxTokens: 128000, efforts: ["low", "medium", "high", "xhigh", "max"], input: ["text", "image"], created: 1795000000, chat: true });
  // A ChatGPT model listed under several plans keeps the smallest context, so it fits every plan.
  assert.equal(catalog.get("codex:gpt-6.1-terra").contextWindow, 500000);
  // Image models are not chat models.
  assert.equal(catalog.get("codex:gpt-image-2.6").chat, false);
  assert.equal(catalog.get("antigravity:gemini-3.1-flash-image").chat, false);
  // Gemini's 1M "output limit" is the context, not a usable output cap; it is limited to 65536.
  assert.equal(catalog.get("antigravity:gemini-4-carbon-high").maxTokens, 65536);
  // Only text and image are kept as inputs, the two DeepSeek Harness accepts.
  assert.deepEqual(catalog.get("antigravity:gemini-4-carbon-high").input, ["text", "image"]);
});

test("a catalog that is not an object reads as empty", () => {
  assert.equal(parseCatalog(null).size, 0);
  assert.equal(parseCatalog("nope").size, 0);
  assert.equal(parseCatalog({ claude: "not a list" }).size, 0);
});

test("more old generations are recognised", () => {
  for (const id of ["gpt-4o", "gpt-4o-mini", "o3", "o4-mini", "chatgpt-4o-latest", "kimi-k2", "kimi-k2.5"]) assert.equal(isCurrent(id), false, id);
  for (const id of ["kimi-k2.6", "kimi-k2.8", "kimi-k3", "kimi-k3.1-pro"]) assert.equal(isCurrent(id), true, id);
});

test("a dated model ID is not taken for a newer version", () => {
  const catalog = parseCatalog({ claude: [{ id: "claude-opus-5-20260101", display_name: "Opus 5 (dated)", context_length: 1000000, max_completion_tokens: 128000 }] });
  const models = buildModels({ catalog, served: [{ id: "claude-opus-5-20260101", owned_by: "anthropic" }], accounts: new Set(["claude"]), extra: [] });
  assert.deepEqual(suggestions({ main: ["claude-opus-5-5"] }, models), []);
});

test("a context size from the catalog is capped", () => {
  const catalog = parseCatalog({ claude: [{ id: "claude-huge-9", context_length: 1e12, max_completion_tokens: 1e9 }] });
  const entry = catalog.get("claude:claude-huge-9");
  assert.equal(entry.contextWindow, 2000000);
  assert.equal(entry.maxTokens, 128000);
});

test("old model generations are not current", () => {
  assert.equal(isCurrent("claude-3-7-sonnet-20250219"), false);
  assert.equal(isCurrent("claude-opus-4-8"), false);
  assert.equal(isCurrent("gpt-5.6-terra"), false);
  assert.equal(isCurrent("claude-opus-5"), true);
  assert.equal(isCurrent("gpt-6-sol"), true);
  assert.equal(isCurrent("gemini-3.8-flash-high"), true);
});

// What the backend serves to these accounts.
const SERVED = [
  { id: "claude-fable-5-2", owned_by: "anthropic" },
  { id: "claude-fable-5-3", owned_by: "anthropic" },
  { id: "claude-opus-5", owned_by: "anthropic" },
  { id: "claude-3-7-sonnet-20250219", owned_by: "anthropic" },
  { id: "gpt-6.1-terra", owned_by: "openai" },
  { id: "gpt-6-sol", owned_by: "openai" },
  { id: "gpt-image-2.6", owned_by: "openai" },
  { id: "gemini-4-carbon-high", owned_by: "antigravity" },
  { id: "gemini-4-hydrogen-xhigh", owned_by: "antigravity" },
  { id: "claude-sonnet-5-5-high", owned_by: "antigravity" },
  { id: "gemini-3.1-flash-image", owned_by: "antigravity" },
  { id: "mystery-model-9", owned_by: "anthropic" }
];

const ids = (models) => models.map((model) => model.id);

test("every current chat model an account serves is offered, with catalog figures", () => {
  const models = buildModels({ catalog: parseCatalog(CATALOG), served: SERVED, accounts: new Set(["claude", "codex", "antigravity"]), extra: [] });
  const byId = Object.fromEntries(models.map((model) => [model.id, model]));
  // New since the hand-written list:
  assert.ok(byId["claude-fable-5-3"]);
  assert.ok(byId["gpt-6-sol"]);
  assert.ok(byId["gemini-4-hydrogen-xhigh"]);
  // Catalog figures win over the hand-written ones.
  assert.equal(byId["gpt-6.1-terra"].contextWindow, 500000);
  assert.deepEqual(byId["gemini-4-carbon-high"].efforts, ["low", "medium", "high"]);
  // The route is chosen by account.
  assert.equal(byId["claude-fable-5-3"].api, "claude");
  assert.equal(byId["gpt-6-sol"].api, "openai");
  assert.equal(byId["gemini-4-hydrogen-xhigh"].api, "compat");
  // New models are marked.
  assert.equal(byId["claude-fable-5-3"].isNew, true);
  assert.equal(byId["claude-fable-5-2"].isNew, false);
});

test("image models, old generations and models the catalog does not describe are left out unless chosen", () => {
  const models = buildModels({ catalog: parseCatalog(CATALOG), served: SERVED, accounts: new Set(["claude", "codex", "antigravity"]), extra: [] });
  const offered = new Set(ids(models));
  for (const id of ["gpt-image-2.6", "gemini-3.1-flash-image", "claude-3-7-sonnet-20250219", "mystery-model-9"]) assert.equal(offered.has(id), false, id);

  const chosen = buildModels({ catalog: parseCatalog(CATALOG), served: SERVED, accounts: new Set(["claude", "codex", "antigravity"]), extra: ["claude-3-7-sonnet-20250219", "mystery-model-9"] });
  const byId = Object.fromEntries(chosen.map((model) => [model.id, model]));
  assert.equal(byId["claude-3-7-sonnet-20250219"].contextWindow, 200000);
  // An undescribed model gets safe defaults.
  assert.deepEqual([byId["mystery-model-9"].contextWindow, byId["mystery-model-9"].maxTokens, byId["mystery-model-9"].efforts], [200000, 32000, []]);
});

test("Gemini keeps headroom below Google's 1,048,576-token limit", () => {
  const models = buildModels({ catalog: parseCatalog(CATALOG), served: SERVED, accounts: new Set(["antigravity"]), extra: [] });
  assert.equal(models.find((model) => model.id === "gemini-4-carbon-high").contextWindow, 900000);
  assert.equal(models.find((model) => model.id === "gemini-4-hydrogen-xhigh").contextWindow, 900000);
});

test("a model the user switched off is not offered, even a hand-written one", () => {
  const models = buildModels({ catalog: parseCatalog(CATALOG), served: SERVED, accounts: new Set(["claude"]), extra: [], hidden: ["claude-fable-5-2", "claude-opus-5"] });
  assert.equal(ids(models).includes("claude-fable-5-2"), false);
  assert.equal(ids(models).includes("claude-opus-5"), false);
  assert.ok(ids(models).includes("claude-fable-5-3"));
});

test("the full list marks what is offered, hidden by default, or switched off", () => {
  const { listModels } = require("../src/models");
  const listed = listModels({ catalog: parseCatalog(CATALOG), served: SERVED, accounts: new Set(["claude", "codex", "antigravity"]), extra: ["claude-3-7-sonnet-20250219"], hidden: ["claude-opus-5"] });
  const byId = Object.fromEntries(listed.map((item) => [item.id, item]));
  assert.deepEqual([byId["claude-fable-5-3"].offered, byId["claude-fable-5-3"].reason], [true, "new"]);
  assert.deepEqual([byId["claude-fable-5-2"].offered, byId["claude-fable-5-2"].reason], [true, "known"]);
  assert.deepEqual([byId["claude-opus-5"].offered, byId["claude-opus-5"].reason], [false, "switched off"]);
  assert.deepEqual([byId["claude-3-7-sonnet-20250219"].offered, byId["claude-3-7-sonnet-20250219"].reason], [true, "switched on"]);
  assert.deepEqual([byId["gpt-image-2.6"].offered, byId["gpt-image-2.6"].reason], [false, "not a chat model"]);
  assert.deepEqual([byId["mystery-model-9"].offered, byId["mystery-model-9"].reason], [false, "not in the catalog"]);
  assert.equal(byId["ag-c55s-high"].account, "antigravity");
});

test("Claude served through Google keeps its short dshgate name", () => {
  const models = buildModels({ catalog: parseCatalog(CATALOG), served: SERVED, accounts: new Set(["antigravity"]), extra: [] });
  const viaGoogle = models.find((model) => model.upstream === "claude-sonnet-5-5-high");
  assert.equal(viaGoogle.id, "ag-c55s-high");
  assert.equal(viaGoogle.api, "compat");
  assert.equal(ids(models).includes("claude-sonnet-5-5-high"), false);
});

test("models of an account that is not signed in are not offered", () => {
  const models = buildModels({ catalog: parseCatalog(CATALOG), served: SERVED, accounts: new Set(["claude"]), extra: [] });
  assert.equal(models.some((model) => model.account !== "claude"), false);
});

test("without the catalog or the served list, the hand-written models are still offered", () => {
  const models = buildModels({ catalog: new Map(), served: [], accounts: new Set(["claude", "codex"]), extra: [] });
  assert.ok(ids(models).includes("claude-fable-5-2"));
  assert.ok(ids(models).includes("gpt-6-astra"));
  assert.equal(models.find((model) => model.id === "claude-fable-5-2").isNew, false);
});

test("a newer version of a model on a lane is suggested, never applied", () => {
  const models = buildModels({ catalog: parseCatalog(CATALOG), served: SERVED, accounts: new Set(["claude", "codex", "antigravity"]), extra: [] });
  const lanes = { main: ["gpt-6-astra", "claude-fable-5-2", "gemini-4-carbon-high"], architect: ["claude-fable-5-2", "gpt-6.1-terra"], scout: ["claude-haiku-5-5"] };
  assert.deepEqual(suggestions(lanes, models), [{ from: "claude-fable-5-2", to: "claude-fable-5-3", lanes: ["main", "architect"] }]);
  // The lanes object is not changed.
  assert.deepEqual(lanes.main, ["gpt-6-astra", "claude-fable-5-2", "gemini-4-carbon-high"]);
});

test("a model already on the lane, or an older one, is not suggested", () => {
  const models = buildModels({ catalog: parseCatalog(CATALOG), served: SERVED, accounts: new Set(["claude"]), extra: [] });
  assert.deepEqual(suggestions({ main: ["claude-fable-5-3", "claude-fable-5-2"] }, models), []);
  assert.deepEqual(suggestions({ main: ["claude-opus-5-5"] }, models), []);
});
