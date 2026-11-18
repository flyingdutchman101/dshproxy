const test = require("node:test");
const assert = require("node:assert/strict");

const { applyPrimary, PRIMARY_PRIORITY } = require("../src/primary");
const settings = require("../src/settings");

// Two plans with one provider: one account serves until it is out of quota,
// then the next. The backend picks the credential with the highest priority
// that is available, so the primary account gets a priority and the others
// get none.
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

test("the primary account gets the priority and the provider's other accounts lose theirs", async () => {
  const management = fakeManagement({ "claude-new.json": PRIMARY_PRIORITY });
  const result = await applyPrimary({ management, accounts: ACCOUNTS, primary: { claude: "claude-old.json" } });
  assert.deepEqual(management.calls.sort(), [["claude-new.json", 0], ["claude-old.json", PRIMARY_PRIORITY]]);
  assert.deepEqual(result, { changed: ["claude-new.json", "claude-old.json"], failed: [] });
  // The ChatGPT account has no choice recorded and is not touched.
  assert.equal(management.state["codex-a.json"], undefined);
});

test("nothing is sent when the backend already has it right", async () => {
  const management = fakeManagement({ "claude-old.json": PRIMARY_PRIORITY });
  const result = await applyPrimary({ management, accounts: ACCOUNTS, primary: { claude: "claude-old.json" } });
  assert.deepEqual(management.calls, []);
  assert.deepEqual(result, { changed: [], failed: [] });
});

test("a primary account that is signed out leaves the provider's accounts equal", async () => {
  const management = fakeManagement({ "claude-new.json": PRIMARY_PRIORITY });
  const result = await applyPrimary({ management, accounts: ACCOUNTS, primary: { claude: "claude-gone.json" } });
  assert.deepEqual(management.calls, [["claude-new.json", 0]]);
  assert.deepEqual(result.changed, ["claude-new.json"]);
});

test("a choice never crosses providers", async () => {
  const management = fakeManagement();
  await applyPrimary({ management, accounts: ACCOUNTS, primary: { claude: "codex-a.json" } });
  assert.deepEqual(management.calls, []);
});

test("an account the backend refuses is reported and the others are still set", async () => {
  const management = fakeManagement({ "claude-new.json": PRIMARY_PRIORITY }, { failFor: "claude-new.json" });
  const result = await applyPrimary({ management, accounts: ACCOUNTS, primary: { claude: "claude-old.json" } });
  assert.deepEqual(result.changed, ["claude-old.json"]);
  assert.deepEqual(result.failed, [{ file: "claude-new.json", error: "backend said no" }]);
});

test("the choice of primary account is a setting, kept per provider", () => {
  const clean = settings.sanitize({ primary: { claude: "claude-old.json", codex: "..\\secrets.json", "Bad Provider": "x.json", kimi: 7 } });
  assert.deepEqual(clean.primary, { claude: "claude-old.json" });
  assert.deepEqual(settings.sanitize({}).primary, {});
  assert.deepEqual(settings.sanitize({ primary: "claude-old.json" }).primary, {});
});
