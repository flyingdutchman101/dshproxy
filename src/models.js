// Which subscription models to offer, worked out from three sources:
//
// - what the backend serves to the signed-in accounts (GET /v1/models),
// - CLIProxyAPI's model catalog (sizes, reasoning levels, release dates),
// - the hand-written list in catalog.js (names DeepSeek Harness already uses,
//   and figures for models the catalog does not describe).
//
// A model the backend serves and the catalog describes is offered without a
// dshgate update. Image models and older generations are offered only when
// the user picks them.

const { SUBSCRIPTION_MODELS } = require("./catalog");

const CATALOG_URLS = [
  "https://models.router-for.me/models.json",
  "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json"
];

// Catalog sections and backend owners, by account type.
const SECTION_ACCOUNT = { claude: "claude", antigravity: "antigravity", kimi: "kimi" };
const OWNER_ACCOUNT = { anthropic: "claude", openai: "codex", antigravity: "antigravity", moonshot: "kimi", kimi: "kimi" };
const ROUTE = { claude: "claude", codex: "openai", antigravity: "compat", kimi: "compat" };

// The route a model is declared on in DeepSeek Harness is chosen by its
// protocol: Claude through Google still goes through the compat route.
function routeFor(account) {
  return ROUTE[account] || "compat";
}

function accountForSection(section) {
  if (section.startsWith("codex")) return "codex";
  return SECTION_ACCOUNT[section] || null;
}

const DEFAULT_CONTEXT = 200000;
const DEFAULT_MAX_TOKENS = 32000;
// Gemini reports its context window as the output limit too.
const MAX_OUTPUT = 128000;
const GEMINI_OUTPUT = 65536;
// Google rejects anything over 1,048,576 tokens and counts tokens differently
// from DeepSeek Harness, so Gemini is declared smaller to leave room for
// compaction.
const GEMINI_CONTEXT = 900000;
// No catalog figure larger than this is believed.
const MAX_CONTEXT = 2000000;

const numberOr = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

function entryFrom(raw, account) {
  const output = Array.isArray(raw.supportedOutputModalities) ? raw.supportedOutputModalities : null;
  const chat = Boolean(raw.context_length) && (!output || output.includes("text")) && !/image|video|tts|audio|embed/i.test(String(raw.id));
  const inputs = Array.isArray(raw.supportedInputModalities) ? raw.supportedInputModalities.filter((item) => item === "text" || item === "image") : ["text", "image"];
  let maxTokens = numberOr(raw.max_completion_tokens, DEFAULT_MAX_TOKENS);
  if (account === "antigravity" && maxTokens > MAX_OUTPUT) maxTokens = GEMINI_OUTPUT;
  let contextWindow = Math.min(numberOr(raw.context_length, DEFAULT_CONTEXT), MAX_CONTEXT);
  if (account === "antigravity" && /^gemini-/.test(String(raw.id))) contextWindow = Math.min(contextWindow, GEMINI_CONTEXT);
  return {
    id: String(raw.id),
    account,
    name: String(raw.display_name || raw.name || raw.id),
    contextWindow,
    maxTokens: Math.min(maxTokens, MAX_OUTPUT),
    efforts: Array.isArray(raw.thinking?.levels) ? raw.thinking.levels.map(String) : [],
    input: inputs.length ? inputs : ["text"],
    created: Number(raw.created) || null,
    chat
  };
}

// Reads the catalog into a map keyed "account:model". A ChatGPT model listed
// under several plans keeps the smallest figures, so they fit every plan.
function parseCatalog(json) {
  const catalog = new Map();
  if (!json || typeof json !== "object" || Array.isArray(json)) return catalog;
  for (const [section, list] of Object.entries(json)) {
    const account = accountForSection(section);
    if (!account || !Array.isArray(list)) continue;
    for (const raw of list) {
      if (!raw || typeof raw !== "object" || !raw.id) continue;
      const entry = entryFrom(raw, account);
      const key = `${account}:${entry.id}`;
      const existing = catalog.get(key);
      if (!existing) {
        catalog.set(key, entry);
        continue;
      }
      existing.contextWindow = Math.min(existing.contextWindow, entry.contextWindow);
      existing.maxTokens = Math.min(existing.maxTokens, entry.maxTokens);
    }
  }
  return catalog;
}

// Older generations: Claude 3 and 4, GPT 4 and 5 and the o-series, Gemini 1
// and 2, Kimi K2 before 2.6.
const OLD = [
  /^claude-(3|4)(-|\.)/,
  /^claude-(opus|sonnet|haiku)-(3|4)(-|$)/,
  /^gpt-(4|5)/,
  /^chatgpt-4/,
  /^o\d/,
  /^gemini-(1|2)(\.|-)/,
  /^codex-/,
  /^gpt-oss-/,
  /^kimi-k2(?!\.([6-9]|\d\d))/
];

function isCurrent(id) {
  return !OLD.some((pattern) => pattern.test(id));
}

// The hand-written entries, keyed by the ID the backend uses.
const HANDWRITTEN = new Map(SUBSCRIPTION_MODELS.map((model) => [`${model.account}:${model.upstream || model.id}`, model]));

// Every model the signed-in accounts can serve, with whether it is offered and
// why. `extra` are IDs the user switched on although hidden by default;
// `hidden` are IDs the user switched off.
function listModels({ catalog, served, accounts, extra = [], hidden = [] }) {
  const on = new Set(extra);
  const off = new Set(hidden);
  const listed = new Map();

  const add = (account, upstreamId) => {
    const hand = HANDWRITTEN.get(`${account}:${upstreamId}`);
    const entry = catalog.get(`${account}:${upstreamId}`);
    const id = hand ? hand.id : upstreamId;
    if (listed.has(id)) return;
    const byDefault = Boolean(hand) || Boolean(entry && entry.chat && isCurrent(upstreamId));
    let reason;
    if (off.has(id)) reason = "switched off";
    else if (on.has(id) && !byDefault) reason = "switched on";
    else if (hand) reason = "known";
    else if (!entry) reason = "not in the catalog";
    else if (!entry.chat) reason = "not a chat model";
    else if (!isCurrent(upstreamId)) reason = "older generation";
    else reason = "new";
    const offered = !off.has(id) && (byDefault || on.has(id));
    const base = hand || { id, name: upstreamId, contextWindow: DEFAULT_CONTEXT, maxTokens: DEFAULT_MAX_TOKENS, efforts: [] };
    listed.set(id, {
      ...base,
      id,
      name: hand ? hand.name : entry?.name || upstreamId,
      account,
      api: hand ? hand.api : routeFor(account),
      contextWindow: entry?.contextWindow || base.contextWindow,
      maxTokens: entry?.maxTokens || base.maxTokens,
      efforts: entry?.efforts?.length ? entry.efforts : base.efforts,
      ...(entry?.input ? { input: entry.input } : {}),
      ...(hand?.upstream ? { upstream: hand.upstream } : {}),
      created: entry?.created || null,
      isNew: !hand,
      offered,
      reason
    });
  };

  // Models the backend actually serves.
  for (const item of Array.isArray(served) ? served : []) {
    const account = OWNER_ACCOUNT[String(item?.owned_by || "")];
    if (!account || !accounts.has(account) || !item.id) continue;
    add(account, String(item.id));
  }
  // Hand-written models of signed-in accounts, so a backend that has not
  // listed its models yet still offers them.
  for (const model of SUBSCRIPTION_MODELS) {
    if (accounts.has(model.account)) add(model.account, model.upstream || model.id);
  }
  return [...listed.values()];
}

// The models to offer, in the shape catalog.js uses.
function buildModels(options) {
  return listModels(options).filter((model) => model.offered).map(({ offered, reason, ...model }) => model);
}

// "claude-fable-5-2" -> { family: "claude-fable", version: [5, 2] }.
function versionOf(id) {
  // A trailing date ("-20260101") is a snapshot, not a version.
  const undated = id.replace(/-\d{8,}$/, "");
  const match = /^(.*?)-(\d+(?:[.-]\d+)*)((?:-[a-z]+)*)$/.exec(undated);
  if (!match) return null;
  return { family: `${match[1]}${match[3]}`, version: match[2].split(/[.-]/).map(Number) };
}

function compareVersions(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

// For each model on a lane, the newest offered model of the same family when
// it is newer. Nothing is changed; the user decides.
function suggestions(lanes, models) {
  const offered = models.map((model) => ({ id: model.id, parsed: versionOf(model.id) })).filter((item) => item.parsed);
  const found = new Map();
  for (const [lane, ladder] of Object.entries(lanes || {})) {
    for (const id of ladder) {
      const current = versionOf(id);
      if (!current) continue;
      const newer = offered
        .filter((item) => item.parsed.family === current.family && compareVersions(item.parsed.version, current.version) > 0 && !ladder.includes(item.id))
        .sort((a, b) => compareVersions(b.parsed.version, a.parsed.version))[0];
      if (!newer) continue;
      const key = `${id}>${newer.id}`;
      if (!found.has(key)) found.set(key, { from: id, to: newer.id, lanes: [] });
      if (!found.get(key).lanes.includes(lane)) found.get(key).lanes.push(lane);
    }
  }
  return [...found.values()];
}

// Downloads the catalog, trying each source in turn. Returns the parsed JSON.
async function fetchCatalog({ fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  let lastError = null;
  for (const url of CATALOG_URLS) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`The model catalog could not be downloaded: ${lastError?.message || "unknown error"}`);
}

module.exports = { CATALOG_URLS, parseCatalog, listModels, buildModels, suggestions, isCurrent, fetchCatalog, routeFor };
