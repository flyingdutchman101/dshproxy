// Remembers which model served each conversation on a lane, so a conversation
// that moved to a backup rung stays there instead of returning to the first
// rung as soon as its cool-down ends. Switching models mid-conversation throws
// away the prompt cache and can confuse tool history.

const crypto = require("crypto");

const SESSION_HEADERS = ["x-session-id", "x-claude-code-session-id", "session_id"];

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && (block.type === "text" || block.type === "input_text")).map((block) => block.text || "").join("\n");
}

// First user text of an Anthropic Messages, Chat Completions or Responses body.
function firstUserText(body) {
  if (typeof body?.input === "string") return body.input;
  const items = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  const first = items.find((item) => item?.role === "user");
  return first ? textOf(first.content) : "";
}

function createSessions({ max = 1000 } = {}) {
  const served = new Map();

  // An explicit session ID is used when the client sends one. Otherwise the
  // first user message identifies the conversation: it is the same on every
  // later turn. Only a hash of it is kept. A request with neither has no
  // session (null), so unrelated requests are never tied together.
  function keyFor(lane, headers, body) {
    const header = SESSION_HEADERS.map((name) => headers[name]).find((value) => typeof value === "string" && value);
    const text = firstUserText(body);
    let source;
    if (header) source = `h:${header}`;
    else if (typeof body?.prompt_cache_key === "string" && body.prompt_cache_key) source = `p:${body.prompt_cache_key}`;
    else if (text.trim()) source = `t:${text}`;
    else return null;
    return `${lane}|${crypto.createHash("sha256").update(source).digest("hex").slice(0, 32)}`;
  }

  function get(key) {
    return served.get(key) ?? null;
  }

  function set(key, model) {
    served.delete(key);
    served.set(key, model);
    while (served.size > max) served.delete(served.keys().next().value);
  }

  return { keyFor, get, set };
}

module.exports = { createSessions };
