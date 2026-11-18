const test = require("node:test");
const assert = require("node:assert/strict");

const { createAccountOrder, PRIMARY_PRIORITY, SECONDARY_PRIORITY } = require("../src/primary");

// The order in which a provider's accounts are used, kept in step with what
// the usage report says: who goes first, who steps aside, and which account
// is not asked for a model it has run out of.

const NOW = Date.parse("2026-11-18T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const FABLE = "claude-fable-*";
const ACCOUNTS = [
  { file: "claude-old.json", provider: "claude", label: "Claude", account: "old@example.com", disabled: false },
  { file: "claude-new.json", provider: "claude", label: "Claude", account: "new@example.com", disabled: false },
  { file: "codex-a.json", provider: "codex", label: "ChatGPT", account: "a@example.com", disabled: false }
];

// Stand-ins for the backend's Management API, the usage report and the clock.
function setup({ primary = { claude: "claude-old.json" }, accounts = ACCOUNTS, usedUp = new Map(), usedUpModels = new Map() } = {}) {
  const world = {
    primary,
    accounts,
    usedUp,
    usedUpModels,
    priorities: {},
    calls: [],
    usageReads: 0,
    logs: [],
    timers: [],
    usageFails: false,
    hold: null
  };
  const management = {
    credentials: async () => {
      world.calls.push(["credentials"]);
      if (world.hold) await world.hold;
      return world.accounts.map((account) => (world.priorities[account.file] ? { name: account.file, priority: world.priorities[account.file] } : { name: account.file }));
    },
    setPriority: async (name, priority) => {
      world.calls.push(["priority", name, priority]);
      world.priorities[name] = priority;
    },
    setExcludedModels: async (name, models) => {
      world.calls.push(["exclude", name, models]);
    }
  };
  const limits = {
    usedUp: async () => {
      world.usageReads += 1;
      if (world.usageFails) throw new Error("usage endpoint is down");
      return world.usedUp;
    },
    usedUpModels: async () => world.usedUpModels
  };
  world.order = createAccountOrder({
    management,
    limits,
    listAccounts: () => world.accounts,
    primary: () => world.primary,
    log: (line) => world.logs.push(line),
    now: () => NOW,
    setTimer: (run, delay) => {
      const timer = { run, delay, cleared: false };
      world.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    }
  });
  world.sent = (kind) => world.calls.filter((call) => call[0] === kind).map((call) => call.slice(1));
  return world;
}

test("the chosen account goes first and the others follow", async () => {
  const world = setup();
  await world.order.apply();
  assert.deepEqual(world.sent("priority").sort(), [["claude-new.json", SECONDARY_PRIORITY], ["claude-old.json", PRIMARY_PRIORITY]]);
  // The provider without a choice gets no place in any order.
  assert.equal(world.sent("priority").some((call) => call[0] === "codex-a.json"), false);
});

test("without a choice the usage report is not read and the accounts are left equal", async () => {
  const world = setup({ primary: {} });
  await world.order.apply();
  assert.equal(world.usageReads, 0);
  assert.deepEqual(world.sent("priority"), []);
  // A refused model is no reason to look when there is no order to keep.
  const before = world.calls.length;
  world.order.refresh({ ifChosen: true });
  await world.order.idle();
  assert.equal(world.calls.length, before);
});

// The backend keeps the order in each account's file. A choice taken back
// while the gateway was not running (`dshproxy accounts primary claude none`)
// must not leave the old order behind.
test("an order the backend still holds for a provider without a choice is removed", async () => {
  const world = setup({ primary: {} });
  world.priorities = { "claude-old.json": PRIMARY_PRIORITY, "claude-new.json": SECONDARY_PRIORITY };
  await world.order.apply();
  assert.deepEqual(world.sent("priority").sort(), [["claude-new.json", 0], ["claude-old.json", 0]]);
  assert.deepEqual(world.sent("exclude").sort(), [["claude-new.json", []], ["claude-old.json", []], ["codex-a.json", []]]);
});

test("a paused account is left alone until it is resumed", async () => {
  const world = setup({ accounts: ACCOUNTS.map((account) => (account.file === "claude-new.json" ? { ...account, disabled: true } : account)) });
  await world.order.apply();
  assert.equal(world.calls.some((call) => call[1] === "claude-new.json"), false);
  world.accounts = ACCOUNTS;
  await world.order.apply();
  assert.deepEqual(world.sent("priority").at(-1), ["claude-new.json", SECONDARY_PRIORITY]);
  assert.deepEqual(world.sent("exclude").at(-1), ["claude-new.json", []]);
});

// Signing out deletes the account's file, and signing in again writes a new
// one under the same name, without the exclusion.
test("after a change of accounts every account is told again", async () => {
  const world = setup({ usedUpModels: new Map([["claude-old.json", new Map([[FABLE, NOW + 28 * HOUR]])]]) });
  await world.order.apply();
  world.order.forget();
  await world.order.apply();
  assert.deepEqual(world.sent("exclude").filter((call) => call[0] === "claude-old.json"), [["claude-old.json", [FABLE]], ["claude-old.json", [FABLE]]]);
});

test("a run the backend did not answer is tried again a minute later", async () => {
  const world = setup();
  const working = world.order;
  let down = true;
  const push = world.calls.push.bind(world.calls);
  world.calls.push = (call) => {
    push(call);
    if (call[0] === "credentials" && down) throw new Error("the backend did not answer in time");
    return world.calls.length;
  };
  await assert.rejects(working.apply(), /did not answer/);
  const timer = world.timers.at(-1);
  assert.equal(timer.delay, 60 * 1000);
  down = false;
  timer.run();
  await working.idle();
  assert.equal(world.priorities["claude-old.json"], PRIMARY_PRIORITY);
});

test("an account that is out of quota steps aside and is checked again a minute after its reset", async () => {
  const world = setup({ usedUp: new Map([["claude-old.json", NOW + 5 * HOUR]]) });
  await world.order.apply();
  assert.deepEqual(world.sent("priority").sort(), [["claude-new.json", SECONDARY_PRIORITY]]);
  assert.equal(world.priorities["claude-old.json"], undefined);
  assert.match(world.logs.join("\n"), /old@example\.com.*out of quota.*steps aside/);

  const timer = world.timers.at(-1);
  assert.equal(timer.delay, 5 * HOUR + 60 * 1000);
  // The limit has reset: the account is first again.
  world.usedUp = new Map();
  timer.run();
  await world.order.idle();
  assert.equal(world.priorities["claude-old.json"], PRIMARY_PRIORITY);
});

test("an account that has run out of one model is not asked for it while another account has it", async () => {
  const world = setup({ usedUpModels: new Map([["claude-old.json", new Map([[FABLE, NOW + 28 * HOUR]])]]) });
  await world.order.apply();
  assert.deepEqual(world.sent("exclude").filter((call) => call[1].length), [["claude-old.json", [FABLE]]]);
  // It stays the primary account for every other model.
  assert.equal(world.priorities["claude-old.json"], PRIMARY_PRIORITY);
  assert.match(world.logs.join("\n"), /old@example\.com.*claude-fable-\*/);
  assert.equal(world.timers.at(-1).delay, 28 * HOUR + 60 * 1000);

  // After the reset it is asked again.
  world.usedUpModels = new Map();
  await world.order.apply();
  assert.deepEqual(world.sent("exclude").at(-1), ["claude-old.json", []]);
});

test("a model nobody else has is not taken away: the provider's own refusal must come back", async () => {
  const out = new Map([[FABLE, NOW + 28 * HOUR]]);
  // Both accounts are out of the model.
  const both = setup({ usedUpModels: new Map([["claude-old.json", out], ["claude-new.json", out]]) });
  await both.order.apply();
  assert.deepEqual(both.sent("exclude").filter((call) => call[1].length), []);

  // The only other account is paused, or out of quota altogether.
  const paused = setup({ accounts: ACCOUNTS.map((account) => (account.file === "claude-new.json" ? { ...account, disabled: true } : account)), usedUpModels: new Map([["claude-old.json", out]]) });
  await paused.order.apply();
  assert.deepEqual(paused.sent("exclude").filter((call) => call[1].length), []);
  const aside = setup({ usedUp: new Map([["claude-new.json", NOW + HOUR]]), usedUpModels: new Map([["claude-old.json", out]]) });
  await aside.order.apply();
  assert.deepEqual(aside.sent("exclude").filter((call) => call[1].length), []);
});

test("what the backend already has is not sent again", async () => {
  const world = setup({ usedUpModels: new Map([["claude-old.json", new Map([[FABLE, NOW + 28 * HOUR]])]]) });
  await world.order.apply();
  const before = world.calls.filter((call) => call[0] !== "credentials").length;
  await world.order.apply();
  await world.order.apply();
  assert.equal(world.calls.filter((call) => call[0] !== "credentials").length, before);
});

test("a first run clears what an earlier run of the program may have left behind", async () => {
  // The backend keeps an exclusion in the account's file; this program does
  // not remember across a restart what it sent.
  const world = setup();
  await world.order.apply();
  assert.deepEqual(world.sent("exclude").sort(), [["claude-new.json", []], ["claude-old.json", []], ["codex-a.json", []]]);
});

test("a usage report that cannot be read leaves the order as chosen", async () => {
  const world = setup();
  world.usageFails = true;
  const result = await world.order.apply();
  assert.deepEqual(result.failed, []);
  assert.equal(world.priorities["claude-old.json"], PRIMARY_PRIORITY);
  assert.equal(world.priorities["claude-new.json"], SECONDARY_PRIORITY);
});

test("requests that arrive during a run share one more run, not one each", async () => {
  const world = setup();
  let release;
  world.hold = new Promise((done) => {
    release = done;
  });
  const first = world.order.apply();
  const second = world.order.apply();
  const third = world.order.apply();
  world.order.refresh();
  assert.equal(second, third, "later callers share the run that follows");
  world.hold = null;
  release();
  await Promise.all([first, second, third]);
  await world.order.idle();
  assert.equal(world.sent("credentials").length, 2);
});

test("taking the choice back makes the provider's accounts equal again", async () => {
  const world = setup({ usedUpModels: new Map([["claude-old.json", new Map([[FABLE, NOW + 28 * HOUR]])]]) });
  await world.order.apply();
  world.primary = {};
  await world.order.apply();
  assert.equal(world.priorities["claude-old.json"], 0);
  assert.equal(world.priorities["claude-new.json"], 0);
  assert.deepEqual(world.sent("exclude").at(-1), ["claude-old.json", []]);
});

test("a backend that refuses one change is reported and does not stop the rest", async () => {
  const world = setup();
  const failing = world.order;
  // Replace one call with a failure after the module was created.
  const original = world.calls.push.bind(world.calls);
  world.calls.push = (call) => {
    original(call);
    if (call[0] === "exclude" && call[1] === "claude-new.json") throw new Error("backend said no");
    return world.calls.length;
  };
  const result = await failing.apply();
  assert.deepEqual(result.failed, [{ file: "claude-new.json", error: "backend said no" }]);
  assert.equal(world.priorities["claude-old.json"], PRIMARY_PRIORITY);
  assert.match(world.logs.join("\n"), /new@example\.com.*could not be set.*backend said no/);
  // What was refused is tried again a minute later.
  assert.equal(world.timers.at(-1).delay, 60 * 1000);
});

test("stopping cancels the check that was waiting for a reset", async () => {
  const world = setup({ usedUp: new Map([["claude-old.json", NOW + 5 * HOUR]]) });
  await world.order.apply();
  world.order.stop();
  assert.equal(world.timers.at(-1).cleared, true);
  // Nothing runs after a stop.
  const before = world.calls.length;
  world.order.refresh();
  await world.order.idle();
  assert.equal(world.calls.length, before);
});
