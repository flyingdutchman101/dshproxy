const test = require("node:test");
const assert = require("node:assert/strict");

const presets = require("../src/presets");
const catalog = require("../src/catalog");
const { DEFAULT_LANES } = require("../src/settings");

test("there are three routing presets, each covering every lane", () => {
  assert.deepEqual(presets.names(), ["performance", "balanced", "cheap"]);
  const lanes = Object.keys(DEFAULT_LANES).sort();
  for (const name of presets.names()) {
    const preset = presets.get(name);
    assert.equal(typeof preset.label, "string");
    assert.equal(typeof preset.summary, "string");
    assert.deepEqual(Object.keys(preset.lanes).sort(), lanes, `${name} misses a lane`);
    for (const ladder of Object.values(preset.lanes)) assert.ok(ladder.length >= 2, `${name} has a one-rung lane`);
  }
});

test("every model named in a preset exists in the catalog", () => {
  for (const name of presets.names()) {
    for (const [lane, ladder] of Object.entries(presets.get(name).lanes)) {
      for (const id of ladder) assert.ok(catalog.findModel(id), `${name}/${lane} names unknown model ${id}`);
    }
  }
});

test("the balanced preset is the working default", () => {
  assert.deepEqual(presets.get("balanced").lanes, DEFAULT_LANES);
  assert.equal(presets.describe(DEFAULT_LANES).name, "balanced");
});

test("edited ladders are reported as custom", () => {
  const edited = { ...DEFAULT_LANES, main: ["claude-opus-5-5"] };
  assert.equal(presets.describe(edited).name, "custom");
  assert.equal(presets.describe(edited).label, "Custom");
});

test("an unknown preset is refused and the names are given", () => {
  assert.throws(() => presets.get("fastest"), /Unknown routing preset "fastest". Use one of: performance, balanced, cheap\./);
});

test("performance puts the strongest models first; cheap prefers quota and cheap API models", () => {
  const performance = presets.get("performance").lanes;
  const cheap = presets.get("cheap").lanes;
  assert.equal(performance.main[0], "gpt-6-astra");
  assert.ok(performance.main.includes("claude-opus-5-5"));
  assert.ok(!cheap.main.some((id) => id.startsWith("gpt-6")), "cheap should not spend on GPT 6");
  assert.ok(cheap.scout.includes("qwen/qwen3.8-flash"));
});
