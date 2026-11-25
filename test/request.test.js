const test = require("node:test");
const assert = require("node:assert/strict");

const { nearestEffort, clampEffort, prepareBody } = require("../src/gateway/request");

const body = (value) => Buffer.from(JSON.stringify(value), "utf8");
const parse = (buffer) => JSON.parse(buffer.toString("utf8"));

test("a supported reasoning level is kept", () => {
  assert.equal(nearestEffort("high", ["low", "high", "max"]), "high");
});

test("an unsupported level maps to the closest one, the higher on a tie", () => {
  // xhigh sits between high and max; medium sits between low and high.
  assert.equal(nearestEffort("xhigh", ["low", "high", "max"]), "max");
  assert.equal(nearestEffort("medium", ["low", "high"]), "high");
  assert.equal(nearestEffort("minimal", ["low", "high"]), "low");
  assert.equal(nearestEffort("max", ["high"]), "high");
});

test("a level outside the known scale maps to the model's top level", () => {
  assert.equal(nearestEffort("ultra", ["low", "high"]), "high");
});

test("both spellings of the reasoning level are clamped", () => {
  const request = { reasoning_effort: "xhigh", reasoning: { effort: "low", summary: "auto" } };
  assert.equal(clampEffort(request, ["high"]), true);
  assert.deepEqual(request, { reasoning_effort: "high", reasoning: { effort: "high", summary: "auto" } });
});

test("a model without reasoning levels has the level removed", () => {
  const request = { reasoning_effort: "high", reasoning: { effort: "high" } };
  assert.equal(clampEffort(request, []), true);
  assert.deepEqual(request, { reasoning: {} });
});

test("an unknown model's reasoning level is left alone", () => {
  const request = { reasoning_effort: "xhigh" };
  assert.equal(clampEffort(request, null), false);
  assert.deepEqual(request, { reasoning_effort: "xhigh" });
});

test("a request that needs no change keeps its exact bytes", () => {
  // Unusual spacing and key order would not survive a re-serialization.
  const raw = Buffer.from('{ "stream":true,  "model":"claude-opus-5-5","reasoning_effort":"high" }', "utf8");
  assert.equal(prepareBody(raw, "claude-opus-5-5", { efforts: ["low", "high"] }), raw);
});

test("a lane request is rewritten to the rung that serves it", () => {
  const raw = body({ model: "lane-main", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(parse(prepareBody(raw, "gpt-6-astra")), { model: "gpt-6-astra", messages: [{ role: "user", content: "hi" }] });
});

test("Qwen Cloud accepts developer instructions as system messages without changing other attempts", () => {
  const developer = { role: "developer", content: [{ type: "text", text: "second instruction" }] };
  const system = { role: "system", content: "first instruction" };
  const user = { role: "user", content: "developer" };
  for (const field of ["messages", "input"]) {
    const model = "openrouter/qwen/example";
    const raw = body({ model, [field]: [system, developer, user] });
    assert.deepEqual(parse(prepareBody(raw, "qwen/example"))[field], [system, { ...developer, role: "system" }, user]);
    assert.equal(prepareBody(raw, model), raw);
  }
});

test("a model served under another upstream name is sent with that name", () => {
  const raw = body({ model: "ag-c55o-high", reasoning_effort: "max" });
  assert.deepEqual(parse(prepareBody(raw, "ag-c55o-high", { efforts: ["high"], upstream: "claude-opus-5-5-high" })), { model: "claude-opus-5-5-high", reasoning_effort: "high" });
});
