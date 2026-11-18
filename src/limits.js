// Subscription limits: how much of each window (5-hour, weekly, monthly) is
// left and when it resets. Each provider's usage endpoint is called by the
// backend with the account's own token, so DSHProxy never handles tokens.

const WINDOW_KIND = { short: "short", daily: "daily", weekly: "weekly", monthly: "monthly", other: "other" };
const KIND_ORDER = ["short", "daily", "weekly", "monthly", "other"];

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace("%", "").trim());
    return value.trim() && Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// A reset time from an ISO date, Unix seconds or milliseconds, or "seconds
// from now".
function resetAt(value, now) {
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (!name.includes("reset")) continue;
    if (typeof item === "string" && item.trim()) {
      const parsed = Date.parse(item);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
      const number = numberValue(item);
      if (number !== null) return fromNumber(name, number, now);
    }
    if (typeof item === "number" && Number.isFinite(item)) return fromNumber(name, item, now);
  }
  return null;
}

function fromNumber(name, value, now) {
  if (name.includes("after") || name.includes("in_seconds") || name.endsWith("_in")) return new Date(now + value * 1000).toISOString();
  return new Date(value > 1e11 ? value : value * 1000).toISOString();
}

function kindFromSeconds(seconds) {
  if (!(seconds > 0)) return null;
  const hours = seconds / 3600;
  if (hours >= 24 * 28) return WINDOW_KIND.monthly;
  if (hours >= 24 * 6) return WINDOW_KIND.weekly;
  if (hours >= 23) return WINDOW_KIND.daily;
  return WINDOW_KIND.short;
}

function kindFromTitle(title) {
  if (/month|30.?day/i.test(title)) return WINDOW_KIND.monthly;
  if (/week|7.?day/i.test(title)) return WINDOW_KIND.weekly;
  if (/day|24.?h/i.test(title)) return WINDOW_KIND.daily;
  if (/hour|\dh\b|minute/i.test(title)) return WINDOW_KIND.short;
  return WINDOW_KIND.other;
}

function titleFromSeconds(seconds, fallback) {
  if (!(seconds > 0)) return fallback;
  const hours = seconds / 3600;
  if (hours >= 24 * 28) return "Monthly";
  if (hours >= 24 * 6) return "Weekly";
  if (hours >= 24) return `${Math.round(hours / 24)}-day`;
  return `${Math.round(hours)}-hour`;
}

function window(title, usedPercent, reset, kind) {
  if (typeof usedPercent !== "number") return null;
  const used = Math.max(0, Math.min(100, usedPercent));
  return { title, kind: kind || kindFromTitle(title), usedPercent: Math.round(used * 10) / 10, leftPercent: Math.round((100 - used) * 10) / 10, resetsAt: reset, reported: true };
}

// A window the plan is expected to have but the provider did not report.
function unreported(title, kind) {
  return { title, kind, usedPercent: null, leftPercent: null, resetsAt: null, reported: false };
}

// The windows of one ChatGPT rate_limit object. The window's length names it,
// because plans differ (5-hour and weekly, or weekly only).
function codexWindows(limits, now, prefix = "") {
  if (!limits || typeof limits !== "object") return [];
  return [limits.primary_window, limits.secondary_window].filter((item) => item && typeof item === "object").map((item, index) => {
    const seconds = numberValue(item.limit_window_seconds);
    const title = titleFromSeconds(seconds, index === 0 ? "5-hour" : "Weekly");
    return window(prefix ? `${prefix} · ${title}` : title, numberValue(item.used_percent), resetAt(item, now), kindFromSeconds(seconds) || (index === 0 ? WINDOW_KIND.short : WINDOW_KIND.weekly));
  }).filter(Boolean);
}

// ChatGPT: the account's hourly and weekly windows, hourly first. A plan that
// reports no hourly window still shows one, marked as not reported, so it is
// clear the hourly limit was asked for. Model limits follow.
function parseCodex(json, now = Date.now()) {
  if (!json?.rate_limit || typeof json.rate_limit !== "object") return [];
  const main = codexWindows(json.rate_limit, now);
  if (!main.length) return [];
  const short = main.filter((item) => item.kind === WINDOW_KIND.short);
  const longer = main.filter((item) => item.kind !== WINDOW_KIND.short);
  const ordered = [...(short.length ? short : [unreported("5-hour", WINDOW_KIND.short)]), ...longer];
  if (!longer.length) ordered.push(unreported("Weekly", WINDOW_KIND.weekly));
  const extra = (Array.isArray(json.additional_rate_limits) ? json.additional_rate_limits : []).flatMap((item) => {
    const name = String(item?.limit_name || item?.normal_model_slug || "Model");
    return codexWindows(item?.rate_limit || item, now, name);
  });
  return [...ordered, ...extra];
}

// The limit resets ChatGPT offers on this account, or null when it offers none.
function codexResets(json) {
  const summary = json?.rate_limit_reset_credits;
  const available = numberValue(summary?.available_count);
  if (!available || available <= 0) return null;
  const applicable = numberValue(summary?.applicable_available_count);
  return { available, applicable: applicable === null ? available : applicable };
}

const CLAUDE_WINDOWS = [
  ["five_hour", "5-hour", WINDOW_KIND.short],
  ["seven_day", "Weekly", WINDOW_KIND.weekly],
  ["seven_day_opus", "Weekly (Opus)", WINDOW_KIND.weekly],
  ["seven_day_sonnet", "Weekly (Sonnet)", WINDOW_KIND.weekly],
  ["seven_day_oauth_apps", "Weekly (OAuth apps)", WINDOW_KIND.weekly],
  ["seven_day_cowork", "Weekly (Cowork)", WINDOW_KIND.weekly]
];

function scopeName(scope) {
  const name = scope?.model?.display_name || scope?.model?.id || scope?.surface?.display_name || scope?.surface?.id;
  return name ? String(name) : "limited";
}

// Claude: one object per window, `utilization` already a percentage. Limits
// that apply to one model (for example Fable on a team plan) appear only in
// `limits` as "weekly_scoped"; each becomes its own window unless a named
// window above already shows it.
function parseClaude(json, now = Date.now()) {
  if (!json || typeof json !== "object") return [];
  const named = CLAUDE_WINDOWS.filter(([key]) => json[key] && typeof json[key] === "object").map(([key, title, kind]) => window(title, numberValue(json[key].utilization), resetAt(json[key], now), kind)).filter(Boolean);
  const shown = new Set(named.map((item) => item.title.toLowerCase()));
  const scoped = (Array.isArray(json.limits) ? json.limits : [])
    .filter((item) => item && typeof item === "object" && String(item.kind || "").endsWith("_scoped"))
    .map((item) => {
      const group = String(item.group || item.kind).startsWith("session") ? "5-hour" : "Weekly";
      return window(`${group} (${scopeName(item.scope)})`, numberValue(item.percent), resetAt(item, now), group === "5-hour" ? WINDOW_KIND.short : WINDOW_KIND.weekly);
    })
    .filter((item) => item && !shown.has(item.title.toLowerCase()));
  return [...named, ...scoped];
}

// Claude limits that stop every model of an account when they are used up.
// Any other window (a surface, another product) is left out on purpose: a
// model is only set aside on a limit known to apply to it.
const CLAUDE_ACCOUNT_WINDOWS = new Set(["5-hour", "Weekly", "Weekly (OAuth apps)"]);
const CLAUDE_FAMILIES = new Set(["fable", "opus", "sonnet", "haiku"]);

// "claude-fable-5-2" -> "fable"; null for anything that is not a Claude model.
function claudeFamily(model) {
  const family = /^claude-([a-z]+)-/.exec(String(model || ""))?.[1];
  return family && CLAUDE_FAMILIES.has(family) ? family : null;
}

// `entries` are the accounts of a limits read. A model is out of quota only
// when every active Claude account shows a used-up limit that applies to it;
// it returns when the first of those accounts is free again. Null when an
// account can serve it, or when a report is missing or names no reset time.
function claudeQuotaReset(entries, model) {
  const family = claudeFamily(model);
  const active = (Array.isArray(entries) ? entries : []).filter((entry) => entry.provider === "claude" && !entry.disabled);
  if (!family || !active.length) return null;
  let earliest = null;
  for (const entry of active) {
    if (entry.error) return null;
    let blockedUntil = null;
    for (const item of entry.windows || []) {
      if (item.reported === false || !(item.usedPercent >= 100)) continue;
      const scope = /^(?:Weekly|5-hour) \((.+)\)$/.exec(item.title)?.[1];
      if (!CLAUDE_ACCOUNT_WINDOWS.has(item.title) && !(scope && scope.toLowerCase() === family)) continue;
      const reset = Date.parse(item.resetsAt);
      if (!Number.isFinite(reset)) return null;
      blockedUntil = Math.max(blockedUntil ?? 0, reset);
    }
    if (blockedUntil === null) return null;
    earliest = earliest === null ? blockedUntil : Math.min(earliest, blockedUntil);
  }
  return earliest;
}

// "Gemini Models" -> "Gemini", "Claude and GPT models" -> "Claude/GPT".
function shortGroup(name) {
  const trimmed = String(name).replace(/\s*models?\s*$/i, "").trim();
  return trimmed.replace(/\s+and\s+/i, "/") || "Gemini";
}

// "Five Hour Limit Remaining" -> "5-hour", "Weekly Limit Remaining" -> "Weekly".
function shortBucket(name) {
  const text = String(name);
  if (/five.?hour|5.?h/i.test(text)) return "5-hour";
  if (/week/i.test(text)) return "Weekly";
  if (/month/i.test(text)) return "Monthly";
  if (/day|daily/i.test(text)) return "Daily";
  return text.replace(/\s*(limit\s*)?remaining\s*$/i, "").trim() || "Limit";
}

// Gemini (Antigravity): groups such as "Gemini models" and "Claude and GPT
// models", each with buckets carrying the fraction that is left.
function parseAntigravitySummary(json, now = Date.now()) {
  const payload = json?.response || json?.summary || json;
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  return groups.flatMap((group) => (Array.isArray(group.buckets) ? group.buckets : []).filter((bucket) => !bucket.disabled).map((bucket) => {
    const left = numberValue(bucket.remaining?.remainingFraction ?? bucket.remainingFraction);
    if (left === null) return null;
    const groupName = shortGroup(group.displayName || group.name || "Gemini");
    const bucketName = shortBucket(bucket.displayName || bucket.name || bucket.window || "Limit");
    return window(`${groupName} · ${bucketName}`, (1 - left) * 100, resetAt(bucket, now) || resetAt(bucket.remaining, now), kindFromTitle(bucketName));
  }).filter(Boolean))
    // Shorter windows first within each group, as for the other services.
    .sort((a, b) => (a.title.split(" · ")[0] === b.title.split(" · ")[0] ? KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) : 0));
}

// Fallback: per-model quota from the model list.
function parseAntigravityModels(json, wanted, now = Date.now()) {
  const models = json?.models && typeof json.models === "object" ? json.models : {};
  return Object.entries(models)
    .filter(([id, model]) => (!wanted || wanted.has(id)) && numberValue(model?.quotaInfo?.remainingFraction) !== null)
    .map(([id, model]) => window(model.displayName || model.label || id, (1 - numberValue(model.quotaInfo.remainingFraction)) * 100, resetAt(model.quotaInfo, now), WINDOW_KIND.other))
    .filter(Boolean);
}

const ANTIGRAVITY_HEADERS = { "Content-Type": "application/json", "User-Agent": "antigravity/hub/2.9.1 windows/amd64", Authorization: "Bearer $TOKEN$" };

// The body of a call the backend made, or an error with the upstream status.
function bodyOf(reply, what) {
  const status = Number(reply?.status_code);
  if (status === 401 || status === 403) throw new Error(`${what} refused the account (HTTP ${status}). Sign in again.`);
  if (!(status >= 200 && status < 300)) throw new Error(`${what} returned HTTP ${status || "nothing"}`);
  try {
    return JSON.parse(String(reply.body || ""));
  } catch {
    throw new Error(`${what} returned something that is not JSON`);
  }
}

const CHATGPT = "https://chatgpt.com/backend-api";

function codexHeader(details, extra = {}) {
  const header = { Authorization: "Bearer $TOKEN$", Accept: "application/json", "User-Agent": "codex-cli", ...extra };
  if (details.accountId) header["ChatGPT-Account-Id"] = details.accountId;
  return header;
}

// Returns { windows, resets }.
async function fetchWindows({ management, account, authIndex, details, wantedModels, now }) {
  if (account.provider === "codex") {
    const json = bodyOf(await management.apiCall({ authIndex, url: `${CHATGPT}/wham/usage`, header: codexHeader(details) }), "ChatGPT");
    return { windows: parseCodex(json, now), resets: codexResets(json) };
  }
  const windows = await fetchOtherWindows({ management, account, authIndex, details, wantedModels, now });
  return { windows, resets: null };
}

async function fetchOtherWindows({ management, account, authIndex, details, wantedModels, now }) {
  if (account.provider === "claude") {
    const reply = await management.apiCall({ authIndex, url: "https://api.anthropic.com/api/oauth/usage", header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" } });
    return parseClaude(bodyOf(reply, "Claude"), now);
  }
  if (account.provider === "antigravity") {
    let project = details.projectId;
    if (!project) {
      const reply = await management.apiCall({ authIndex, method: "POST", url: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", header: ANTIGRAVITY_HEADERS, data: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }) });
      const ref = bodyOf(reply, "Gemini")?.cloudaicompanionProject;
      project = typeof ref === "string" ? ref : ref?.id;
    }
    const data = JSON.stringify(project ? { project } : {});
    try {
      const summary = parseAntigravitySummary(bodyOf(await management.apiCall({ authIndex, method: "POST", url: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", header: ANTIGRAVITY_HEADERS, data }), "Gemini"), now);
      if (summary.length) return summary;
    } catch {
      // The summary is not offered to every account; the model list is.
    }
    return parseAntigravityModels(bodyOf(await management.apiCall({ authIndex, method: "POST", url: "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", header: ANTIGRAVITY_HEADERS, data }), "Gemini"), wantedModels, now);
  }
  return null;
}

// `accounts` are entries from accounts.list(); `detailsFor(file)` returns the
// non-secret IDs a usage call needs ({ accountId, projectId, plan }).
function createLimits({ management, detailsFor, wantedModels = null, cacheMs = 60 * 1000, now = Date.now }) {
  let cache = null;
  let reading = null;

  // Callers that arrive while a read is under way share it: a burst of
  // requests must not become a burst of usage calls.
  function read({ accounts, force = false }) {
    if (!force && cache && now() - cache.at < cacheMs) return Promise.resolve(cache.value);
    if (!force && reading) return reading;
    const started = fetchAll(accounts).finally(() => {
      if (reading === started) reading = null;
    });
    reading = started;
    return started;
  }

  async function fetchAll(accounts) {
    const credentials = await management.credentials();
    const byName = new Map(credentials.map((item) => [item.name, item]));
    const results = await Promise.all(accounts.map(async (account) => {
      const credential = byName.get(account.file);
      const details = detailsFor(account.file) || {};
      const entry = {
        file: account.file,
        provider: account.provider,
        label: account.label,
        account: account.account,
        plan: details.plan || null,
        disabled: account.disabled,
        state: credential ? String(credential.status || "active") : "not loaded",
        stateMessage: credential?.status_message ? String(credential.status_message) : null,
        windows: [],
        resets: null,
        supported: account.provider !== "kimi",
        error: null
      };
      if (!entry.supported || account.disabled) return entry;
      if (!credential || credential.auth_index === undefined || credential.auth_index === null) {
        entry.error = "The backend has not loaded this account yet.";
        return entry;
      }
      try {
        const fetched = await fetchWindows({ management, account, authIndex: String(credential.auth_index), details, wantedModels, now: now() });
        entry.windows = fetched.windows || [];
        entry.resets = fetched.resets || null;
        if (!entry.windows.some((item) => item.reported !== false)) entry.error = "No limits were reported.";
      } catch (error) {
        entry.error = error.message;
      }
      return entry;
    }));
    const value = { fetchedAt: new Date(now()).toISOString(), accounts: results };
    cache = { at: now(), value };
    return value;
  }

  // When `model` can be served again (a timestamp), if the usage report shows
  // that no active account can serve it now; null when one can or when the
  // report does not tell. Uses the cached report.
  async function quotaReset({ accounts, model }) {
    if (!claudeFamily(model)) return null;
    return claudeQuotaReset((await read({ accounts })).accounts, model);
  }

  // The provider's usage reply for one account, as received, with anything
  // that looks like a credential removed. For diagnosing what a provider
  // reports.
  async function raw({ accounts, file }) {
    const account = accounts.find((item) => item.file === file);
    if (!account) throw new Error("That account is not signed in.");
    const credential = (await management.credentials()).find((item) => item.name === file);
    if (!credential) throw new Error("The backend has not loaded this account yet.");
    const authIndex = String(credential.auth_index);
    const details = detailsFor(file) || {};
    const urls = {
      codex: "https://chatgpt.com/backend-api/wham/usage",
      claude: "https://api.anthropic.com/api/oauth/usage"
    };
    const url = urls[account.provider];
    if (!url) throw new Error(`No raw usage view for ${account.label}.`);
    const header = account.provider === "codex"
      ? { Authorization: "Bearer $TOKEN$", Accept: "application/json", "User-Agent": "codex-cli", ...(details.accountId ? { "ChatGPT-Account-Id": details.accountId } : {}) }
      : { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" };
    const reply = await management.apiCall({ authIndex, url, header });
    let body;
    try {
      body = JSON.parse(String(reply.body || ""));
    } catch {
      body = String(reply.body || "").slice(0, 2000);
    }
    return { status: Number(reply.status_code), body: scrub(body) };
  }

  // The ChatGPT account whose resets are asked for, with its backend index.
  async function codexAccount(accounts, file) {
    const account = accounts.find((item) => item.file === file);
    if (!account) throw new Error("That account is not signed in.");
    if (account.provider !== "codex") throw new Error("Limit resets are offered by ChatGPT only.");
    const credential = (await management.credentials()).find((item) => item.name === file);
    if (!credential) throw new Error("The backend has not loaded this account yet.");
    return { account, authIndex: String(credential.auth_index), details: detailsFor(file) || {} };
  }

  // The resets on offer, with what each one restores.
  async function listResets({ accounts, file }) {
    const { authIndex, details } = await codexAccount(accounts, file);
    const json = bodyOf(await management.apiCall({ authIndex, url: `${CHATGPT}/wham/rate-limit-reset-credits`, header: codexHeader(details) }), "ChatGPT");
    const credits = (Array.isArray(json?.credits) ? json.credits : [])
      .filter((item) => item && String(item.status) === "available" && item.id)
      .map((item) => ({ id: String(item.id), title: item.title ? String(item.title) : "Limit reset", description: item.description ? String(item.description) : null, expiresAt: item.expires_at ? String(item.expires_at) : null }));
    return { available: numberValue(json?.available_count) ?? credits.length, credits };
  }

  // Uses one reset. `requestId` makes a retried request count once.
  // `creditId` picks a reset; without it ChatGPT picks one.
  async function useReset({ accounts, file, creditId = null, requestId }) {
    if (!requestId) throw new Error("A request ID is required to use a reset.");
    const { authIndex, details } = await codexAccount(accounts, file);
    const body = { redeem_request_id: String(requestId), ...(creditId ? { credit_id: String(creditId) } : {}) };
    const json = bodyOf(await management.apiCall({ authIndex, method: "POST", url: `${CHATGPT}/wham/rate-limit-reset-credits/consume`, header: codexHeader(details, { "Content-Type": "application/json" }), data: JSON.stringify(body) }), "ChatGPT");
    cache = null;
    const code = String(json?.code || "unknown");
    const windowsReset = numberValue(json?.windows_reset) || 0;
    const messages = {
      reset: `Reset used: ${windowsReset} limit window${windowsReset === 1 ? " is" : "s are"} full again.`,
      nothing_to_reset: "Nothing to reset: your limits are not used up, so the reset was kept.",
      no_credit: "No reset available on this account.",
      already_redeemed: "That reset has already been used."
    };
    return { code, windowsReset, message: messages[code] || `ChatGPT answered "${code}".` };
  }

  return { read, raw, quotaReset, listResets, useReset, clear: () => (cache = null) };
}

const SECRET_KEY = /token|secret|password|authorization|cookie|api_?key/i;

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[removed]" : scrub(item)]));
}

module.exports = { WINDOW_KIND, parseCodex, parseClaude, parseAntigravitySummary, parseAntigravityModels, codexResets, createLimits };
