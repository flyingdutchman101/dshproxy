const test = require("node:test");
const assert = require("node:assert/strict");

const { carriesImage, filterForImages } = require("../src/gateway/content");

test("an image is recognised in each of the three protocols", () => {
  // Anthropic Messages
  assert.equal(carriesImage({ messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] }] }), true);
  // OpenAI Responses
  assert.equal(carriesImage({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] }] }), true);
  // OpenAI Chat Completions
  assert.equal(carriesImage({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }] }), true);
});

test("a request without an image, or a body that is not understood, says no", () => {
  assert.equal(carriesImage({ messages: [{ role: "user", content: "hello" }] }), false);
  assert.equal(carriesImage({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }), false);
  assert.equal(carriesImage({ input: "hello" }), false);
  assert.equal(carriesImage(null), false);
  assert.equal(carriesImage("text"), false);
});

test("with an image, only models that accept images are tried", () => {
  const withImage = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "AAA" } }] }] };
  assert.deepEqual(filterForImages(["text-only", "vision", "also-vision"], withImage, (id) => id !== "text-only"), ["vision", "also-vision"]);
  assert.deepEqual(filterForImages(["text-only"], withImage, () => false), []);
});

test("without an image every rung stays", () => {
  const textOnly = { messages: [{ role: "user", content: "hello" }] };
  assert.deepEqual(filterForImages(["a", "b"], textOnly, () => false), ["a", "b"]);
});
