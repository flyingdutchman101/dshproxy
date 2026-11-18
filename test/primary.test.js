const test = require("node:test");
const assert = require("node:assert/strict");

const { applyPrimary, PRIMARY_PRIORITY, SECONDARY_PRIORITY } = require("../src/primary");
const settings = require("../src/settings");

// Two plans with one provider: one account serves until it is out of quota,
// then the next. The backend picks the credential with the highest priority
// that is available, so the primary account gets the highest priority, the
// provider's other accounts a lower one, and an account whose limit is used
// up none: it steps aside until the limit resets.
const ACCOUNTS = [
  { file: "claude-old.json", provider: "claude", disabled: false },
  { file: "claude-new.json", provider: "claude", disabled: false },
  { file: "codex-a.json", provider: "codex", disabled: false }
];

// A stand-in for the backend's Management API.
function fakeManagement(priorities = {}, { failFor = null } = {}) {
  const state = { ...priorities };
  const calls = [];
  return {
    calls,
    state,
    credentials: async () => Object.keys({ "claude-old.json": 1, "claude-new.json": 1, "codex-a.json": 1 }).map((name) => (state[name] ? { name, priority: state[name] } : { name })),
    setPriority: async (name, priority) => {
      calls.push([name, priority]);
      if (name === failFor) throw new Error("backend said no");
      state[name] = priority;
    }
  };
}

test("the primary account goes first and the provider's other accounts after it", async () => {
  const management = fakeManagement({ "claude-new.json": PRIMARY_PRIORITY });
  const result = await applyPrimary({ management, accounts: ACCOUNTS, primary: { claude: "claude-old.json" } });
  assert.deepEqual(management.calls.sort(), [["claude-new.json", SECONDARY_PRIORITY], ["claude-old.json", PRIMARY_PRIORITY]]);
  assert.ok(PRIMARY_PRIORITY > SECONDARY_PRIORITY && SECONDARY_PRIORITY > 0);
  assert.deepEqual(result, { changed: ["claude-new.json", "claude-old.json"], failed: [] });
  // The ChatGPT account has no choice recorded and is not touched.
  assert.equal(management.state["codex-a.json"], undefined);
});

test("nothing is sent when the backend already has it right", async () => {
  const management = fakeManagement({ "claude-old.json": PRIMARY_PRIORITY, "claude-new.json": SECONDARY_PRIORITY });
  const result = await applyPrimary({ management, accounts: ACCOUNTS, primary: { claude: "claude-old.json" } });
  assert.deepEqual(management.calls, []);
  assert.deepEqual(result, { changed: [], failed: [] });
});

test("a primary account that is signed out leaves the provider's accounts equal", async () => {
  const management = fakeManagement({ "claude-new.json": PRIMARY_PRIORITY });
  const result = await applyPrimary({ management, accounts: ACCOUNTS, primary: { claude: "claude-gone.json" } });
  assert.deepEqual(management.calls.sort(), [["claude-new.json", SECONDARY_PRIORITY], ["claude-old.json", SECONDARY_PRIORITY]]);
  assert.deepEqual(result.changed, ["claude-new.json", "claude-old.json"]);
});

test("a choice never crosses providers", async () => {
  const management = fakeManagement();
  await applyPrimary({ management, accounts: ACCOUNTS, primary: { claude: "codex-a.json" } });
  // The ChatGPT account is not touched and no Claude account is made primary.
  assert.deepEqual(management.calls.sort(), [["claude-new.json", SECONDARY_PRIORITY], ["claude-old.json", SECONDARY_PRIORITY]]);
});

test("an account the backend refuses is reported and the others are still set", async () => {
  const management = fakeManagement({ "claude-new.json": PRIMARY_PRIORITY }, { failFor: "claude-new.json" });
  const result = await applyPrimary({ management, accounts: ACCOUNTS, primary: { claude: "claude-old.json" } });
  assert.deepEqual(result.changed, ["claude-old.json"]);
  assert.deepEqual(result.failed, [{ file: "claude-new.json", error: "backend said no" }]);
});

// "Use the one which has usage": a primary account that is out of quota would
// otherwise cost one refused call for every new conversation.
test("a primary account whose limit is used up steps aside, and returns when it is not", async () => {
  const management = fakeManagement({ "claude-old.json": PRIMARY_PRIORITY, "claude-new.json": SECONDARY_PRIORITY });
  const primary = { claude: "claude-old.json" };
  await applyPrimary({ management, accounts: ACCOUNTS, primary, usedUp: new Set(["claude-old.json"]) });
  assert.deepEqual(management.calls, [["claude-old.json", 0]]);
  assert.equal(management.state["claude-new.json"], SECONDARY_PRIORITY);

  await applyPrimary({ management, accounts: ACCOUNTS, primary, usedUp: new Set() });
  assert.deepEqual(management.calls[1], ["claude-old.json", PRIMARY_PRIORITY]);
});

test("the choice of primary account is a setting, kept per provider", () => {
  const clean = settings.sanitize({ primary: { claude: "claude-old.json", codex: "..\\secrets.json", "Bad Provider": "x.json", kimi: 7 } });
  assert.deepEqual(clean.primary, { claude: "claude-old.json" });
  assert.deepEqual(settings.sanitize({}).primary, {});
  assert.deepEqual(settings.sanitize({ primary: "claude-old.json" }).primary, {});
});

test("an account-order choice that is taken back resets the provider's priorities", async () => {
  const management = fakeManagement({ "claude-old.json": PRIMARY_PRIORITY, "claude-new.json": SECONDARY_PRIORITY });
  await applyPrimary({ management, accounts: ACCOUNTS, primary: { claude: null } });
  assert.deepEqual(management.calls.sort(), [["claude-new.json", 0], ["claude-old.json", 0]]);
});
