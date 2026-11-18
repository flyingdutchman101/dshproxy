const test = require("node:test");
const assert = require("node:assert/strict");

const presets = require("../src/presets");
const catalog = require("../src/catalog");
const { availability, createResolver } = require("../src/lanes");
const { createFailover } = require("../src/gateway/failover");

// A lane must keep serving when one quota pool runs out. Two situations a
// single user really meets:
//  - only the Claude subscription is usable, and its Fable weekly limit is
//    used up (Fable has its own limit; the other Claude models keep working);
//  - only the ChatGPT subscription is usable.
// The rungs are found the way the gateway finds them: the resolver keeps the
// models an account can serve, and failover drops the ones that are cooling.
const ROLE_LANES = ["main", "scout", "builder", "architect", "reviewer"];

function openRungs(lanes, lane, { accounts, cooling = [] }) {
  const resolve = createResolver({ lanes: () => lanes, isAvailable: availability({ accounts: new Set(accounts), providers: {} }) });
  const failover = createFailover();
  for (const model of cooling) failover.report(model, 429);
  return resolve(`lane-${lane}`).ladder.filter((model) => !failover.isCooling(model));
}

const fableModels = () => catalog.SUBSCRIPTION_MODELS.filter((model) => /^claude-fable-/.test(model.id)).map((model) => model.id);

test("every lane still has a model when Claude is the only account and Fable is used up", () => {
  assert.ok(fableModels().length > 0, "the catalog lists Fable models");
  for (const name of presets.names()) {
    for (const lane of ROLE_LANES) {
      const rungs = openRungs(presets.get(name).lanes, lane, { accounts: ["claude"], cooling: fableModels() });
      assert.ok(rungs.length > 0, `${name}/${lane} has no model left`);
    }
  }
});

// The reviewer lane leaves GPT out on purpose (it must not review GPT's own
// code), and the cheap preset leaves GPT out to save quota.
test("every working lane still has a model when ChatGPT is the only account", () => {
  for (const name of ["performance", "balanced"]) {
    for (const lane of ROLE_LANES.filter((item) => item !== "reviewer")) {
      const rungs = openRungs(presets.get(name).lanes, lane, { accounts: ["codex"] });
      assert.ok(rungs.length > 0, `${name}/${lane} has no model left`);
    }
  }
});

// A review must come from another model family than the one that wrote the
// code, and main and builder start on GPT.
test("no preset reviews with a ChatGPT model", () => {
  const gpt = new Set(catalog.SUBSCRIPTION_MODELS.filter((model) => model.account === "codex").map((model) => model.id));
  for (const name of presets.names()) {
    assert.deepEqual(presets.get(name).lanes.reviewer.filter((id) => gpt.has(id)), [], `${name} reviews with GPT`);
  }
});
