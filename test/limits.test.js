const test = require("node:test");
const assert = require("node:assert/strict");

const { parseCodex, parseClaude, parseAntigravitySummary, parseAntigravityModels, createLimits } = require("../src/limits");

const NOW = Date.parse("2026-11-16T00:00:00Z");

test("ChatGPT windows are named by their length, not their position", () => {
  // Since November 2026 some plans send the weekly window first and no 5-hour one.
  const weeklyOnly = { rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 3600 } } };
  assert.deepEqual(parseCodex(weeklyOnly, NOW), [{ title: "Weekly", kind: "weekly", usedPercent: 40, leftPercent: 60, resetsAt: "2026-11-16T01:00:00.000Z" }]);

  // 1794805200 is 2026-11-16T05:00:00Z in Unix seconds.
  const both = { rate_limit: { primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_at: 1794805200 }, secondary_window: { used_percent: 70, limit_window_seconds: 2592000, reset_at: "2026-12-01T00:00:00Z" } } };
  assert.deepEqual(parseCodex(both, NOW).map((item) => [item.title, item.kind, item.leftPercent, item.resetsAt]), [
    ["5-hour", "short", 87.5, "2026-11-16T05:00:00.000Z"],
    ["Monthly", "monthly", 30, "2026-12-01T00:00:00.000Z"]
  ]);
});

test("a ChatGPT reply without limits gives no windows", () => {
  assert.deepEqual(parseCodex({}, NOW), []);
  assert.deepEqual(parseCodex({ rate_limit: { primary_window: { limit_window_seconds: 18000 } } }, NOW), []);
});

test("Claude windows keep their names and treat utilization as a percentage", () => {
  const reply = {
    five_hour: { utilization: 23, resets_at: "2026-11-16T03:00:00Z" },
    seven_day: { utilization: 81.2, resets_at: "2026-11-20T10:00:00Z" },
    seven_day_opus: { utilization: null },
    extra_usage: { is_enabled: false }
  };
  assert.deepEqual(parseClaude(reply, NOW), [
    { title: "5-hour", kind: "short", usedPercent: 23, leftPercent: 77, resetsAt: "2026-11-16T03:00:00.000Z" },
    { title: "Weekly", kind: "weekly", usedPercent: 81.2, leftPercent: 18.8, resetsAt: "2026-11-20T10:00:00.000Z" }
  ]);
});

test("a usage percentage outside 0 to 100 is clamped", () => {
  assert.deepEqual(parseClaude({ five_hour: { utilization: 130 } }, NOW).map((item) => item.leftPercent), [0]);
  assert.deepEqual(parseClaude({ five_hour: { utilization: -5 } }, NOW).map((item) => item.leftPercent), [100]);
});

test("Gemini groups give one window per bucket, with the fraction that is left", () => {
  const reply = {
    groups: [
      { displayName: "Gemini models", buckets: [{ displayName: "5-hour", remainingFraction: 0.75, resetTime: "2026-11-16T02:00:00Z" }, { displayName: "Weekly", remaining: { remainingFraction: "0.2" }, resetTime: "2026-11-19T00:00:00Z" }] },
      { displayName: "Claude and GPT models", buckets: [{ displayName: "Weekly", remainingFraction: 1, disabled: true }] }
    ]
  };
  assert.deepEqual(parseAntigravitySummary(reply, NOW).map((item) => [item.title, item.kind, item.leftPercent, item.resetsAt]), [
    ["Gemini models · 5-hour", "short", 75, "2026-11-16T02:00:00.000Z"],
    ["Gemini models · Weekly", "weekly", 20, "2026-11-19T00:00:00.000Z"]
  ]);
});

test("Gemini per-model quota is used for the models dshgate offers", () => {
  const reply = { models: { "gemini-4-carbon-high": { displayName: "Gemini 4 Carbon", quotaInfo: { remainingFraction: 0.5, resetTime: "2026-11-16T06:00:00Z" } }, "some-other-model": { quotaInfo: { remainingFraction: 0.1 } } } };
  assert.deepEqual(parseAntigravityModels(reply, new Set(["gemini-4-carbon-high"]), NOW).map((item) => [item.title, item.leftPercent]), [["Gemini 4 Carbon", 50]]);
});

// A stand-in for the backend's Management API. `replies[url]` is what the
// provider returned when the backend called it.
function fakeManagement({ credentials, replies }) {
  const calls = [];
  return {
    calls,
    credentials: async () => credentials,
    apiCall: async (request) => {
      calls.push(request);
      const reply = replies[request.url];
      if (!reply) return { status_code: 404, body: "" };
      return { status_code: reply.status || 200, body: JSON.stringify(reply.body) };
    }
  };
}

const ACCOUNTS = [
  { file: "codex-a.json", provider: "codex", label: "ChatGPT (Codex)", account: "a@example.com", disabled: false },
  { file: "claude-b.json", provider: "claude", label: "Claude", account: "b@example.com", disabled: false },
  { file: "kimi-c.json", provider: "kimi", label: "Kimi", account: "c@example.com", disabled: false },
  { file: "claude-d.json", provider: "claude", label: "Claude", account: "d@example.com", disabled: true }
];
const CREDENTIALS = [
  { name: "codex-a.json", auth_index: "1", status: "active" },
  { name: "claude-b.json", auth_index: "2", status: "active" },
  { name: "kimi-c.json", auth_index: "3", status: "active" },
  { name: "claude-d.json", auth_index: "4", status: "disabled" }
];

test("limits are read through the backend with the account's own token", async () => {
  const management = fakeManagement({
    credentials: CREDENTIALS,
    replies: {
      "https://chatgpt.com/backend-api/wham/usage": { body: { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } } },
      "https://api.anthropic.com/api/oauth/usage": { body: { five_hour: { utilization: 50 } } }
    }
  });
  const limits = createLimits({ management, detailsFor: (file) => (file === "codex-a.json" ? { accountId: "acct-123", plan: "pro" } : {}), now: () => NOW });
  const result = await limits.read({ accounts: ACCOUNTS });
  const byFile = Object.fromEntries(result.accounts.map((item) => [item.file, item]));

  assert.equal(byFile["codex-a.json"].windows[0].leftPercent, 90);
  assert.equal(byFile["codex-a.json"].plan, "pro");
  assert.equal(byFile["claude-b.json"].windows[0].leftPercent, 50);
  // Kimi has no usage endpoint; a disabled account is not asked.
  assert.equal(byFile["kimi-c.json"].supported, false);
  assert.deepEqual(byFile["claude-d.json"].windows, []);

  const codexCall = management.calls.find((call) => call.url.includes("chatgpt.com"));
  assert.equal(codexCall.authIndex, "1");
  assert.equal(codexCall.header.Authorization, "Bearer $TOKEN$");
  assert.equal(codexCall.header["ChatGPT-Account-Id"], "acct-123");
  assert.equal(management.calls.length, 2);
});

test("a refused account is reported, and the other accounts still show their limits", async () => {
  const management = fakeManagement({
    credentials: CREDENTIALS,
    replies: {
      "https://chatgpt.com/backend-api/wham/usage": { status: 401, body: { error: "expired" } },
      "https://api.anthropic.com/api/oauth/usage": { body: { seven_day: { utilization: 5 } } }
    }
  });
  const result = await createLimits({ management, detailsFor: () => ({}), now: () => NOW }).read({ accounts: ACCOUNTS.slice(0, 2) });
  assert.match(result.accounts[0].error, /refused the account \(HTTP 401\)\. Sign in again/);
  assert.equal(result.accounts[1].windows[0].title, "Weekly");
});

test("an account the backend has not loaded is reported instead of asked", async () => {
  const management = fakeManagement({ credentials: [], replies: {} });
  const result = await createLimits({ management, detailsFor: () => ({}), now: () => NOW }).read({ accounts: ACCOUNTS.slice(0, 1) });
  assert.equal(result.accounts[0].state, "not loaded");
  assert.match(result.accounts[0].error, /not loaded/);
  assert.equal(management.calls.length, 0);
});

test("limits are cached for a minute unless a refresh is asked for", async () => {
  let clock = NOW;
  const management = fakeManagement({ credentials: CREDENTIALS, replies: { "https://api.anthropic.com/api/oauth/usage": { body: { five_hour: { utilization: 1 } } } } });
  const limits = createLimits({ management, detailsFor: () => ({}), now: () => clock });
  const accounts = [ACCOUNTS[1]];
  await limits.read({ accounts });
  await limits.read({ accounts });
  assert.equal(management.calls.length, 1);
  await limits.read({ accounts, force: true });
  assert.equal(management.calls.length, 2);
  clock += 61 * 1000;
  await limits.read({ accounts });
  assert.equal(management.calls.length, 3);
});
