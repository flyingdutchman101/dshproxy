const test = require("node:test");
const assert = require("node:assert/strict");

const { createSessions } = require("../src/gateway/sessions");

const anthropic = (first) => ({ messages: [{ role: "user", content: [{ type: "text", text: first }] }, { role: "assistant", content: "ok" }, { role: "user", content: "next" }] });

test("later turns of one conversation share a session", () => {
  const sessions = createSessions();
  const first = { messages: [{ role: "user", content: "build the parser" }] };
  assert.equal(sessions.keyFor("main", {}, first), sessions.keyFor("main", {}, anthropic("build the parser")));
});

test("different conversations and different lanes are different sessions", () => {
  const sessions = createSessions();
  const body = { messages: [{ role: "user", content: "build the parser" }] };
  assert.notEqual(sessions.keyFor("main", {}, body), sessions.keyFor("main", {}, { messages: [{ role: "user", content: "fix the bug" }] }));
  assert.notEqual(sessions.keyFor("main", {}, body), sessions.keyFor("reviewer", {}, body));
});

test("an explicit session ID wins over the conversation text", () => {
  const sessions = createSessions();
  const a = { messages: [{ role: "user", content: "same text" }] };
  assert.notEqual(sessions.keyFor("main", { "x-session-id": "one" }, a), sessions.keyFor("main", { "x-session-id": "two" }, a));
  assert.equal(sessions.keyFor("main", { "x-session-id": "one" }, a), sessions.keyFor("main", { "x-session-id": "one" }, { messages: [{ role: "user", content: "other text" }] }));
  assert.notEqual(sessions.keyFor("main", {}, { ...a, prompt_cache_key: "k1" }), sessions.keyFor("main", {}, { ...a, prompt_cache_key: "k2" }));
});

test("a Responses request is keyed by its first user input", () => {
  const sessions = createSessions();
  const turnOne = { input: [{ role: "user", content: [{ type: "input_text", text: "plan the release" }] }] };
  const turnTwo = { input: [...turnOne.input, { role: "assistant", content: "ok" }, { role: "user", content: "go" }] };
  assert.equal(sessions.keyFor("main", {}, turnOne), sessions.keyFor("main", {}, turnTwo));
  assert.equal(sessions.keyFor("main", {}, { input: "plan the release" }), sessions.keyFor("main", {}, { input: "plan the release" }));
});

test("the session key does not contain the conversation text", () => {
  const key = createSessions().keyFor("main", {}, { messages: [{ role: "user", content: "secret project name" }] });
  assert.ok(!key.includes("secret"));
});

test("a request with no session ID and no user text has no session", () => {
  const sessions = createSessions();
  assert.equal(sessions.keyFor("main", {}, { messages: [] }), null);
  assert.equal(sessions.keyFor("main", {}, { messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }), null);
  assert.equal(sessions.keyFor("main", {}, {}), null);
});

test("the oldest sessions are forgotten first", () => {
  const sessions = createSessions({ max: 2 });
  sessions.set("a", "model-a");
  sessions.set("b", "model-b");
  sessions.set("c", "model-c");
  assert.equal(sessions.get("a"), null);
  assert.equal(sessions.get("b"), "model-b");
  assert.equal(sessions.get("c"), "model-c");
});
