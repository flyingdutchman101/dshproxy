// Subscription limits: how much of each window (5-hour, weekly, monthly) is
// left and when it resets. Each provider's usage endpoint is called by the
// backend with the account's own token, so dshgate never handles tokens.

const WINDOW_KIND = { short: "short", daily: "daily", weekly: "weekly", monthly: "monthly", other: "other" };

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
  return { title, kind: kind || kindFromTitle(title), usedPercent: Math.round(used * 10) / 10, leftPercent: Math.round((100 - used) * 10) / 10, resetsAt: reset };
}

// ChatGPT: rate_limit.primary_window / secondary_window. The window's length
// names it, because plans differ (5-hour and weekly, or only weekly).
function parseCodex(json, now = Date.now()) {
  const limits = json?.rate_limit;
  if (!limits || typeof limits !== "object") return [];
  return [limits.primary_window, limits.secondary_window].filter((item) => item && typeof item === "object").map((item, index) => {
    const seconds = numberValue(item.limit_window_seconds);
    return window(titleFromSeconds(seconds, index === 0 ? "5-hour" : "Weekly"), numberValue(item.used_percent), resetAt(item, now), kindFromSeconds(seconds) || (index === 0 ? WINDOW_KIND.short : WINDOW_KIND.weekly));
  }).filter(Boolean);
}

const CLAUDE_WINDOWS = [
  ["five_hour", "5-hour", WINDOW_KIND.short],
  ["seven_day", "Weekly", WINDOW_KIND.weekly],
  ["seven_day_opus", "Weekly (Opus)", WINDOW_KIND.weekly],
  ["seven_day_sonnet", "Weekly (Sonnet)", WINDOW_KIND.weekly],
  ["seven_day_oauth_apps", "Weekly (OAuth apps)", WINDOW_KIND.weekly],
  ["seven_day_cowork", "Weekly (Cowork)", WINDOW_KIND.weekly]
];

// Claude: one object per window, `utilization` already a percentage.
function parseClaude(json, now = Date.now()) {
  if (!json || typeof json !== "object") return [];
  return CLAUDE_WINDOWS.filter(([key]) => json[key] && typeof json[key] === "object").map(([key, title, kind]) => window(title, numberValue(json[key].utilization), resetAt(json[key], now), kind)).filter(Boolean);
}

// Gemini (Antigravity): groups such as "Gemini models" and "Claude and GPT
// models", each with buckets carrying the fraction that is left.
function parseAntigravitySummary(json, now = Date.now()) {
  const payload = json?.response || json?.summary || json;
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  return groups.flatMap((group) => (Array.isArray(group.buckets) ? group.buckets : []).filter((bucket) => !bucket.disabled).map((bucket) => {
    const left = numberValue(bucket.remaining?.remainingFraction ?? bucket.remainingFraction);
    if (left === null) return null;
    const groupName = group.displayName || group.name || "Gemini";
    const bucketName = bucket.displayName || bucket.name || bucket.window || "Limit";
    return window(`${groupName} · ${bucketName}`, (1 - left) * 100, resetAt(bucket, now) || resetAt(bucket.remaining, now), kindFromTitle(String(bucketName)));
  }).filter(Boolean));
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

async function fetchWindows({ management, account, authIndex, details, wantedModels, now }) {
  if (account.provider === "codex") {
    const header = { Authorization: "Bearer $TOKEN$", Accept: "application/json", "User-Agent": "codex-cli" };
    if (details.accountId) header["ChatGPT-Account-Id"] = details.accountId;
    const reply = await management.apiCall({ authIndex, url: "https://chatgpt.com/backend-api/wham/usage", header });
    return parseCodex(bodyOf(reply, "ChatGPT"), now);
  }
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

  async function read({ accounts, force = false }) {
    if (!force && cache && now() - cache.at < cacheMs) return cache.value;
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
        supported: account.provider !== "kimi",
        error: null
      };
      if (!entry.supported || account.disabled) return entry;
      if (!credential || credential.auth_index === undefined || credential.auth_index === null) {
        entry.error = "The backend has not loaded this account yet.";
        return entry;
      }
      try {
        entry.windows = (await fetchWindows({ management, account, authIndex: String(credential.auth_index), details, wantedModels, now: now() })) || [];
        if (!entry.windows.length) entry.error = "No limits were reported.";
      } catch (error) {
        entry.error = error.message;
      }
      return entry;
    }));
    const value = { fetchedAt: new Date(now()).toISOString(), accounts: results };
    cache = { at: now(), value };
    return value;
  }

  return { read, clear: () => (cache = null) };
}

module.exports = { WINDOW_KIND, parseCodex, parseClaude, parseAntigravitySummary, parseAntigravityModels, createLimits };
