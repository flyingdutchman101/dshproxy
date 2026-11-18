const test = require("node:test");
const assert = require("node:assert/strict");

const { parseCodex, parseClaude, parseAntigravitySummary, parseAntigravityModels, codexResets, createLimits } = require("../src/limits");

const NOW = Date.parse("2026-11-16T00:00:00Z");

test("ChatGPT windows are named by their length, not their position", () => {
  // Since November 2026 some plans send the weekly window first and no 5-hour one.
  const weeklyOnly = { rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 3600 } } };
  assert.deepEqual(parseCodex(weeklyOnly, NOW).filter((item) => item.reported), [{ title: "Weekly", kind: "weekly", usedPercent: 40, leftPercent: 60, resetsAt: "2026-11-16T01:00:00.000Z", reported: true }]);

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
    { title: "5-hour", kind: "short", usedPercent: 23, leftPercent: 77, resetsAt: "2026-11-16T03:00:00.000Z", reported: true },
    { title: "Weekly", kind: "weekly", usedPercent: 81.2, leftPercent: 18.8, resetsAt: "2026-11-20T10:00:00.000Z", reported: true }
  ]);
});

// The shape Claude returned for a team account on 2026-11-16: the per-model
// weekly limit appears only in `limits`, not in the named windows.
const CLAUDE_WITH_SCOPED = {
  five_hour: { utilization: 8, resets_at: "2026-11-16T15:10:00.248661+00:00" },
  seven_day: { utilization: 78, resets_at: "2026-11-19T16:00:00.248684+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: "session", group: "session", percent: 8, resets_at: "2026-11-16T15:10:00.248661+00:00", scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 78, resets_at: "2026-11-19T16:00:00.248684+00:00", scope: null, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 100, severity: "critical", resets_at: "2026-11-19T16:00:00.248874+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true }
  ]
};

test("a Claude per-model weekly limit is shown as its own window", () => {
  assert.deepEqual(parseClaude(CLAUDE_WITH_SCOPED, NOW).map((item) => [item.title, item.kind, item.leftPercent, item.resetsAt]), [
    ["5-hour", "short", 92, "2026-11-16T15:10:00.248Z"],
    ["Weekly", "weekly", 22, "2026-11-19T16:00:00.248Z"],
    ["Weekly (Fable)", "weekly", 0, "2026-11-19T16:00:00.248Z"]
  ]);
});

test("a per-model limit already reported as a named window is not shown twice", () => {
  const reply = {
    seven_day: { utilization: 40 },
    seven_day_opus: { utilization: 70, resets_at: "2026-11-19T16:00:00Z" },
    limits: [
      { kind: "weekly_all", percent: 40, scope: null },
      { kind: "weekly_scoped", percent: 70, resets_at: "2026-11-19T16:00:00Z", scope: { model: { display_name: "Opus" } } }
    ]
  };
  assert.deepEqual(parseClaude(reply, NOW).map((item) => item.title), ["Weekly", "Weekly (Opus)"]);
});

test("a scoped Claude limit without a model name is labelled by its surface or left generic", () => {
  const reply = { limits: [
    { kind: "weekly_scoped", percent: 10, scope: { model: null, surface: { display_name: "Claude Code" } } },
    { kind: "weekly_scoped", percent: 20, scope: null }
  ] };
  assert.deepEqual(parseClaude(reply, NOW).map((item) => item.title), ["Weekly (Claude Code)", "Weekly (limited)"]);
});

test("ChatGPT always shows its hourly window, as not reported when the plan has none", () => {
  // The reply this account returned on 2026-11-16: weekly only.
  const weeklyOnly = { rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 242624, reset_at: 1795068520 }, secondary_window: null } };
  const windows = parseCodex(weeklyOnly, NOW);
  assert.deepEqual(windows.map((item) => [item.title, item.kind, item.leftPercent, item.reported]), [
    ["5-hour", "short", null, false],
    ["Weekly", "weekly", 0, true]
  ]);
});

test("ChatGPT shows the hourly window it reports, first", () => {
  const both = { rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 604800 }, secondary_window: { used_percent: 60, limit_window_seconds: 18000, reset_after_seconds: 600 } } };
  assert.deepEqual(parseCodex(both, NOW).map((item) => [item.title, item.leftPercent, item.reported]), [
    ["5-hour", 40, true],
    ["Weekly", 70, true]
  ]);
});

test("ChatGPT model limits are added from additional_rate_limits", () => {
  const reply = { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } }, additional_rate_limits: [{ limit_name: "GPT 6 Astra", normal_model_slug: "gpt-6-astra", rate_limit: { primary_window: { used_percent: 75, limit_window_seconds: 604800 } } }] };
  assert.deepEqual(parseCodex(reply, NOW).map((item) => [item.title, item.leftPercent]), [
    ["5-hour", 90],
    ["Weekly", null],
    ["GPT 6 Astra · Weekly", 25]
  ]);
});

test("the resets ChatGPT offers are read from its usage reply", () => {
  assert.deepEqual(codexResets({ rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 } }), { available: 1, applicable: 1 });
  assert.deepEqual(codexResets({ rate_limit_reset_credits: { available_count: 2 } }), { available: 2, applicable: 2 });
  assert.equal(codexResets({}), null);
  assert.equal(codexResets({ rate_limit_reset_credits: { available_count: 0 } }), null);
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
    ["Gemini · 5-hour", "short", 75, "2026-11-16T02:00:00.000Z"],
    ["Gemini · Weekly", "weekly", 20, "2026-11-19T00:00:00.000Z"]
  ]);
});

test("Gemini's long window names are shortened", () => {
  // The names Gemini returned on 2026-11-16.
  const reply = { groups: [
    { displayName: "Gemini Models", buckets: [{ displayName: "Five Hour Limit Remaining", remainingFraction: 1 }, { displayName: "Weekly Limit Remaining", remainingFraction: 1 }] },
    { displayName: "Claude and GPT models", buckets: [{ displayName: "Weekly Limit Remaining", remainingFraction: 0.259 }] }
  ] };
  assert.deepEqual(parseAntigravitySummary(reply, NOW).map((item) => [item.title, item.kind]), [
    ["Gemini · 5-hour", "short"],
    ["Gemini · Weekly", "weekly"],
    ["Claude/GPT · Weekly", "weekly"]
  ]);
});

test("Gemini per-model quota is used for the models DSHProxy offers", () => {
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

test("an account's limits carry the resets ChatGPT offers", async () => {
  const management = fakeManagement({
    credentials: CREDENTIALS,
    replies: { "https://chatgpt.com/backend-api/wham/usage": { body: { rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800 } }, rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 } } } }
  });
  const result = await createLimits({ management, detailsFor: () => ({}), now: () => NOW }).read({ accounts: ACCOUNTS.slice(0, 1) });
  assert.deepEqual(result.accounts[0].resets, { available: 1, applicable: 1 });
});

// ---- When a model's quota returns ----

const CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage";
const TWO_CLAUDE = [
  { file: "claude-b.json", provider: "claude", label: "Claude", account: "b@example.com", disabled: false },
  { file: "claude-e.json", provider: "claude", label: "Claude", account: "e@example.com", disabled: false }
];
const TWO_CREDENTIALS = [{ name: "claude-b.json", auth_index: "2", status: "active" }, { name: "claude-e.json", auth_index: "5", status: "active" }];

// Answers the Claude usage call per account (by backend index).
function claudeManagement(byIndex, credentials = TWO_CREDENTIALS) {
  const calls = [];
  return {
    calls,
    credentials: async () => credentials,
    apiCall: async (request) => {
      calls.push(request);
      const reply = request.url === CLAUDE_USAGE ? byIndex[request.authIndex] : null;
      if (!reply) return { status_code: 404, body: "" };
      return { status_code: reply.status || 200, body: JSON.stringify(reply.body) };
    }
  };
}

const quotaLimits = (byIndex, credentials) => createLimits({ management: claudeManagement(byIndex, credentials), detailsFor: () => ({}), now: () => NOW });
const FABLE_RESET = Date.parse("2026-11-19T16:00:00.248Z");

test("a model whose own weekly limit is used up returns when that limit resets", async () => {
  const limits = quotaLimits({ 2: { body: CLAUDE_WITH_SCOPED } }, TWO_CREDENTIALS.slice(0, 1));
  const accounts = TWO_CLAUDE.slice(0, 1);
  assert.equal(await limits.quotaReset({ accounts, model: "claude-fable-5-2" }), FABLE_RESET);
  assert.equal(await limits.quotaReset({ accounts, model: "claude-fable-5-1" }), FABLE_RESET);
  // The same account still serves the other Claude models.
  assert.equal(await limits.quotaReset({ accounts, model: "claude-opus-5-5" }), null);
  assert.equal(await limits.quotaReset({ accounts, model: "claude-haiku-5-5" }), null);
});

test("a used-up account-wide limit stops every model of the account", async () => {
  const body = { five_hour: { utilization: 100, resets_at: "2026-11-16T03:00:00Z" }, seven_day: { utilization: 60, resets_at: "2026-11-20T10:00:00Z" } };
  const limits = quotaLimits({ 2: { body } }, TWO_CREDENTIALS.slice(0, 1));
  assert.equal(await limits.quotaReset({ accounts: TWO_CLAUDE.slice(0, 1), model: "claude-sonnet-5-5" }), Date.parse("2026-11-16T03:00:00Z"));
});

test("with two limits used up the model returns when the later one resets", async () => {
  const body = { ...CLAUDE_WITH_SCOPED, five_hour: { utilization: 100, resets_at: "2026-11-16T03:00:00Z" } };
  const limits = quotaLimits({ 2: { body } }, TWO_CREDENTIALS.slice(0, 1));
  assert.equal(await limits.quotaReset({ accounts: TWO_CLAUDE.slice(0, 1), model: "claude-fable-5-2" }), FABLE_RESET);
});

test("a model is only out of quota when no active account can serve it", async () => {
  const fresh = { five_hour: { utilization: 3, resets_at: "2026-11-16T03:00:00Z" }, seven_day: { utilization: 14, resets_at: "2026-11-22T19:00:00Z" } };
  const oneLeft = quotaLimits({ 2: { body: CLAUDE_WITH_SCOPED }, 5: { body: fresh } });
  assert.equal(await oneLeft.quotaReset({ accounts: TWO_CLAUDE, model: "claude-fable-5-2" }), null);

  // Both used up: the model returns with whichever account resets first.
  const later = { ...CLAUDE_WITH_SCOPED, limits: CLAUDE_WITH_SCOPED.limits.map((item) => (item.kind === "weekly_scoped" ? { ...item, resets_at: "2026-11-22T19:00:00Z" } : item)) };
  const noneLeft = quotaLimits({ 2: { body: later }, 5: { body: CLAUDE_WITH_SCOPED } });
  assert.equal(await noneLeft.quotaReset({ accounts: TWO_CLAUDE, model: "claude-fable-5-2" }), FABLE_RESET);

  // A paused account does not count either way.
  const paused = quotaLimits({ 2: { body: CLAUDE_WITH_SCOPED }, 5: { body: fresh } });
  assert.equal(await paused.quotaReset({ accounts: [TWO_CLAUDE[0], { ...TWO_CLAUDE[1], disabled: true }], model: "claude-fable-5-2" }), FABLE_RESET);
});

test("what cannot be told from the usage report is not treated as used up", async () => {
  const accounts = TWO_CLAUDE.slice(0, 1);
  const one = TWO_CREDENTIALS.slice(0, 1);
  // The usage call failed.
  assert.equal(await quotaLimits({ 2: { status: 429, body: { error: "slow down" } } }, one).quotaReset({ accounts, model: "claude-fable-5-2" }), null);
  // A limit for something else (another model, a surface) is used up.
  const other = { seven_day: { utilization: 10 }, limits: [
    { kind: "weekly_scoped", percent: 100, resets_at: "2026-11-19T16:00:00Z", scope: { model: { display_name: "Opus" } } },
    { kind: "weekly_scoped", percent: 100, resets_at: "2026-11-19T16:00:00Z", scope: { model: null, surface: { display_name: "Fable Studio" } } }
  ] };
  assert.equal(await quotaLimits({ 2: { body: other } }, one).quotaReset({ accounts, model: "claude-fable-5-2" }), null);
  // Used up, but the report does not say until when.
  assert.equal(await quotaLimits({ 2: { body: { seven_day: { utilization: 100 } } } }, one).quotaReset({ accounts, model: "claude-opus-5-5" }), null);
  // Not a Claude model, or no Claude account at all.
  assert.equal(await quotaLimits({ 2: { body: CLAUDE_WITH_SCOPED } }, one).quotaReset({ accounts, model: "gpt-6-astra" }), null);
  assert.equal(await quotaLimits({}, []).quotaReset({ accounts: [], model: "claude-fable-5-2" }), null);
});

test("requests that ask at the same moment share one usage call", async () => {
  const management = claudeManagement({ 2: { body: CLAUDE_WITH_SCOPED } }, TWO_CREDENTIALS.slice(0, 1));
  const limits = createLimits({ management, detailsFor: () => ({}), now: () => NOW });
  const accounts = TWO_CLAUDE.slice(0, 1);
  const answers = await Promise.all([1, 2, 3, 4].map(() => limits.quotaReset({ accounts, model: "claude-fable-5-2" })));
  assert.deepEqual(answers, [FABLE_RESET, FABLE_RESET, FABLE_RESET, FABLE_RESET]);
  assert.equal(management.calls.length, 1);
});

// A stand-in that records calls and answers the reset endpoints.
function resetManagement(replies) {
  const calls = [];
  return {
    calls,
    credentials: async () => CREDENTIALS,
    apiCall: async (request) => {
      calls.push(request);
      const reply = replies[`${request.method || "GET"} ${request.url}`];
      if (!reply) return { status_code: 404, body: "" };
      return { status_code: reply.status || 200, body: JSON.stringify(reply.body) };
    }
  };
}

const RESET_LIST = "GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const RESET_USE = "POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";

test("the resets on offer are listed with their titles and expiry", async () => {
  const management = resetManagement({ [RESET_LIST]: { body: { credits: [{ id: "credit-1", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-11-01T00:00:00Z", expires_at: "2026-12-01T00:00:00Z", title: "Full reset (Weekly + 5 hr)", description: "Ready to redeem" }, { id: "credit-2", status: "redeemed", granted_at: "2026-10-01T00:00:00Z" }], available_count: 1 } } });
  const limits = createLimits({ management, detailsFor: () => ({ accountId: "acct-1" }), now: () => NOW });
  const listed = await limits.listResets({ accounts: ACCOUNTS, file: "codex-a.json" });
  assert.deepEqual(listed, { available: 1, credits: [{ id: "credit-1", title: "Full reset (Weekly + 5 hr)", description: "Ready to redeem", expiresAt: "2026-12-01T00:00:00Z" }] });
  assert.equal(management.calls[0].header.Authorization, "Bearer $TOKEN$");
  assert.equal(management.calls[0].header["ChatGPT-Account-Id"], "acct-1");
});

test("using a reset sends one request with a request ID and the chosen reset, and reports what happened", async () => {
  const management = resetManagement({ [RESET_USE]: { body: { code: "reset", windows_reset: 2 } } });
  const limits = createLimits({ management, detailsFor: () => ({}), now: () => NOW });
  const result = await limits.useReset({ accounts: ACCOUNTS, file: "codex-a.json", creditId: "credit-1", requestId: "req-1" });
  assert.deepEqual(result, { code: "reset", windowsReset: 2, message: "Reset used: 2 limit windows are full again." });
  assert.equal(management.calls.length, 1);
  assert.equal(management.calls[0].method, "POST");
  assert.deepEqual(JSON.parse(management.calls[0].data), { redeem_request_id: "req-1", credit_id: "credit-1" });
});

for (const [code, pattern] of [["nothing_to_reset", /nothing to reset/i], ["no_credit", /no reset available/i], ["already_redeemed", /already been used/i]]) {
  test(`a reset that is not applied (${code}) is reported plainly`, async () => {
    const management = resetManagement({ [RESET_USE]: { body: { code } } });
    const result = await createLimits({ management, detailsFor: () => ({}), now: () => NOW }).useReset({ accounts: ACCOUNTS, file: "codex-a.json", requestId: "req-2" });
    assert.equal(result.code, code);
    assert.match(result.message, pattern);
  });
}

test("a reset cannot be used without a request ID or on an account that does not offer resets", async () => {
  const management = resetManagement({});
  const limits = createLimits({ management, detailsFor: () => ({}), now: () => NOW });
  await assert.rejects(limits.useReset({ accounts: ACCOUNTS, file: "codex-a.json" }), /request ID/);
  await assert.rejects(limits.useReset({ accounts: ACCOUNTS, file: "claude-b.json", requestId: "r" }), /offered by ChatGPT only/);
  assert.equal(management.calls.length, 0);
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

// ---- An account whose own limit is used up ----

test("an account is used up when a limit that covers all its models is at 100%", async () => {
  const weekly = { five_hour: { utilization: 2, resets_at: "2026-11-16T15:10:00Z" }, seven_day: { utilization: 100, resets_at: "2026-11-19T16:00:00Z" } };
  const fresh = { five_hour: { utilization: 3, resets_at: "2026-11-16T15:10:00Z" }, seven_day: { utilization: 14, resets_at: "2026-11-22T19:00:00Z" } };
  const limits = quotaLimits({ 2: { body: weekly }, 5: { body: fresh } });
  assert.deepEqual([...(await limits.usedUp({ accounts: TWO_CLAUDE }))], [["claude-b.json", Date.parse("2026-11-19T16:00:00Z")]]);
});

test("a limit on one model does not make the whole account used up", async () => {
  // Fable is out, and the account still serves Opus, Sonnet and Haiku.
  const limits = quotaLimits({ 2: { body: CLAUDE_WITH_SCOPED } }, TWO_CREDENTIALS.slice(0, 1));
  assert.equal((await limits.usedUp({ accounts: TWO_CLAUDE.slice(0, 1) })).size, 0);
});

test("an account whose usage cannot be read, or whose limit has reset, is not treated as used up", async () => {
  const past = { five_hour: { utilization: 100, resets_at: "2026-11-15T03:00:00Z" }, seven_day: { utilization: 10, resets_at: "2026-11-20T10:00:00Z" } };
  const noTime = { five_hour: { utilization: 100 }, seven_day: { utilization: 10, resets_at: "2026-11-20T10:00:00Z" } };
  assert.equal((await quotaLimits({ 2: { status: 429, body: { error: "rate limited" } }, 5: { body: past } }).usedUp({ accounts: TWO_CLAUDE })).size, 0);
  assert.equal((await quotaLimits({ 2: { body: noTime } }, TWO_CREDENTIALS.slice(0, 1)).usedUp({ accounts: TWO_CLAUDE.slice(0, 1) })).size, 0);
});

// A question about Claude must not make DSHProxy call another provider.
test("a question about one provider reads that provider's usage only", async () => {
  const fresh = { five_hour: { utilization: 3, resets_at: "2026-11-16T15:10:00Z" }, seven_day: { utilization: 14, resets_at: "2026-11-22T19:00:00Z" } };
  const accounts = [...TWO_CLAUDE, { file: "codex-a.json", provider: "codex", label: "ChatGPT", account: "a@example.com", disabled: false }];
  const management = claudeManagement({ 2: { body: fresh }, 5: { body: fresh } }, [...TWO_CREDENTIALS, { name: "codex-a.json", auth_index: "7", status: "active" }]);
  const limits = createLimits({ management, detailsFor: () => ({}), now: () => NOW });

  await limits.quotaReset({ accounts, model: "claude-fable-5-2" });
  await limits.usedUp({ accounts });
  assert.deepEqual(management.calls.map((call) => call.authIndex).sort(), ["2", "5"], "only the two Claude accounts were asked, once each");

  // The Accounts page still gets every account, not the narrower report.
  const report = await limits.read({ accounts });
  assert.deepEqual(report.accounts.map((entry) => entry.file), ["claude-b.json", "claude-e.json", "codex-a.json"]);
  // And a full report that is fresh answers the next question about Claude.
  const before = management.calls.length;
  await limits.usedUp({ accounts });
  assert.equal(management.calls.length, before);
});
