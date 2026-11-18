const test = require("node:test");
const assert = require("node:assert/strict");

const { createFailover } = require("../src/gateway/failover");

const MINUTE = 60 * 1000;

function withClock(options = {}) {
  const clock = { time: Date.parse("2026-11-15T12:00:00Z") };
  const failover = createFailover({ now: () => clock.time, cooldownMs: 10 * MINUTE, maxCooldownMs: 6 * 60 * MINUTE, threshold: 3, ...options });
  return { clock, failover };
}

const LADDER = ["gpt-6-astra", "claude-fable-5-2", "gemini-4-carbon-high"];

test("a request too long for a model moves on without putting the model aside", () => {
  const { failover } = withClock();
  for (const text of [
    '{"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 272000 tokens."}}',
    '{"type":"error","error":{"message":"prompt is too long: 1200000 tokens > 1000000 maximum"}}',
    '{"error":{"message":"Input exceeds the context window of this model"}}'
  ]) {
    const verdict = failover.report("gpt-6-astra", 400, undefined, text);
    assert.equal(verdict.failover, true, text);
    assert.equal(verdict.until, null);
  }
  assert.deepEqual(failover.order(LADDER), LADDER);
});

test("a model no signed-in account serves is put aside", () => {
  const { failover } = withClock();
  const verdict = failover.report("gpt-6-astra", 400, undefined, '{"type":"error","error":{"type":"invalid_request_error","message":"unknown provider for model gpt-6-astra"}}');
  assert.equal(verdict.failover, true);
  assert.equal(verdict.until.toISOString(), "2026-11-15T12:10:00.000Z");
  assert.deepEqual(failover.order(LADDER), ["claude-fable-5-2", "gemini-4-carbon-high"]);
});

test("any other rejection stays with the caller, whatever its text", () => {
  const { failover } = withClock();
  for (const text of ['{"error":{"message":"tools.0.input_schema: field required"}}', '{"error":{"message":"invalid image"}}', "", "not json"]) {
    assert.equal(failover.report("gpt-6-astra", 400, undefined, text).failover, false, text);
  }
  // A too-long message on a success or on an unrelated status changes nothing.
  assert.equal(failover.report("gpt-6-astra", 200, undefined, "prompt is too long").failover, false);
  assert.equal(failover.report("gpt-6-astra", 401, undefined, "unknown provider for model").failover, false);
});

for (const status of [402, 429, 503, 529]) {
  test(`HTTP ${status} moves to the next rung at once and skips the model for ten minutes`, () => {
    const { clock, failover } = withClock();
    const verdict = failover.report("gpt-6-astra", status);
    assert.equal(verdict.failover, true);
    assert.equal(verdict.until.toISOString(), "2026-11-15T12:10:00.000Z");
    assert.deepEqual(failover.order(LADDER), ["claude-fable-5-2", "gemini-4-carbon-high"]);

    clock.time += 10 * MINUTE - 1;
    assert.deepEqual(failover.order(LADDER), ["claude-fable-5-2", "gemini-4-carbon-high"]);
    clock.time += 1;
    assert.deepEqual(failover.order(LADDER), LADDER);
  });
}

test("Retry-After sets the cool-down, capped at six hours", () => {
  const { failover } = withClock();
  assert.equal(failover.report("gpt-6-astra", 429, "1800").until.toISOString(), "2026-11-15T12:30:00.000Z");
  assert.equal(failover.report("claude-fable-5-2", 429, "86400").until.toISOString(), "2026-11-15T18:00:00.000Z");
});

// ChatGPT answered a used-up weekly limit with "retry-after: 66163" (18 hours)
// on 2026-11-18. A shorter cap sends a request to the provider every few hours
// for nothing.
test("by default a provider's Retry-After is honoured for up to a day", () => {
  const clock = { time: Date.parse("2026-11-15T12:00:00Z") };
  const failover = createFailover({ now: () => clock.time });
  assert.equal(failover.report("gpt-6-astra", 429, "66163").until.getTime(), clock.time + 66163 * 1000);
  assert.equal(failover.report("claude-fable-5-2", 429, String(3 * 24 * 3600)).until.getTime(), clock.time + 24 * 3600 * 1000);
});

test("a cool-down says whether the provider gave its end or it is a guess", () => {
  const { failover } = withClock();
  assert.equal(failover.report("gpt-6-astra", 429, "1800").source, "provider");
  assert.equal(failover.report("claude-fable-5-2", 429).source, "default");
  assert.equal(failover.report("gemini-4-carbon-high", 503, "soon").source, "default");
  assert.equal(failover.report("gpt-6.1-terra", 200).source, null);
});

test("a guess never replaces an end the provider gave", () => {
  const { clock, failover } = withClock();
  failover.report("gpt-6-astra", 429, "7200");
  clock.time += MINUTE;
  const again = failover.report("gpt-6-astra", 429);
  assert.equal(again.until.toISOString(), "2026-11-15T14:00:00.000Z");
  assert.equal(again.source, "provider");
  // Once that time has passed, a guess is all there is.
  clock.time += 3 * 60 * MINUTE;
  const later = failover.report("gpt-6-astra", 429);
  assert.equal(later.until.toISOString(), "2026-11-15T15:11:00.000Z");
  assert.equal(later.source, "default");
});

test("an end learned from the provider's usage report cools the model until then", () => {
  const { clock, failover } = withClock();
  const until = failover.coolUntil("claude-fable-5-2", clock.time + 45 * MINUTE);
  assert.equal(until.toISOString(), "2026-11-15T12:45:00.000Z");
  assert.deepEqual(failover.order(LADDER), ["gpt-6-astra", "gemini-4-carbon-high"]);
  assert.equal(failover.report("claude-fable-5-2", 429).source, "provider");
  // Never beyond the longest cool-down.
  assert.equal(failover.coolUntil("gpt-6-astra", clock.time + 30 * 24 * 60 * MINUTE).toISOString(), "2026-11-15T18:00:00.000Z");
});

test("the third server error in a row moves on; the first two do not", () => {
  const { failover } = withClock();
  assert.equal(failover.report("gpt-6-astra", 502).failover, false);
  assert.equal(failover.report("gpt-6-astra", 500).failover, false);
  assert.deepEqual(failover.order(LADDER), LADDER);
  assert.equal(failover.report("gpt-6-astra", 504).failover, true);
  assert.deepEqual(failover.order(LADDER), ["claude-fable-5-2", "gemini-4-carbon-high"]);
});

test("a backend that does not answer counts like a server error", () => {
  const { failover } = withClock();
  failover.report("gpt-6-astra", 0);
  failover.report("gpt-6-astra", 0);
  assert.equal(failover.report("gpt-6-astra", 0).failover, true);
});

test("a success in between restarts the count", () => {
  const { failover } = withClock();
  failover.report("gpt-6-astra", 502);
  failover.report("gpt-6-astra", 502);
  failover.report("gpt-6-astra", 200);
  assert.equal(failover.report("gpt-6-astra", 502).failover, false);
  assert.equal(failover.report("gpt-6-astra", 502).failover, false);
  assert.equal(failover.report("gpt-6-astra", 502).failover, true);
});

test("server errors are counted per model", () => {
  const { failover } = withClock();
  failover.report("gpt-6-astra", 502);
  failover.report("gpt-6-astra", 502);
  assert.equal(failover.report("claude-fable-5-2", 502).failover, false);
});

for (const status of [400, 401, 404, 413, 422]) {
  test(`HTTP ${status} is the caller's error and never moves to another model`, () => {
    const { failover } = withClock();
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(failover.report("gpt-6-astra", status).failover, false);
    assert.deepEqual(failover.order(LADDER), LADDER);
  });
}

test("when every rung is cooling down the whole ladder is still tried", () => {
  const { failover } = withClock();
  for (const model of LADDER) failover.report(model, 429);
  assert.deepEqual(failover.order(LADDER), LADDER);
});

test("a model listed twice on a ladder is tried once", () => {
  const { failover } = withClock();
  assert.deepEqual(failover.order(["gpt-6-astra", "claude-fable-5-2", "gpt-6-astra"]), ["gpt-6-astra", "claude-fable-5-2"]);
});
