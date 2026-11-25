// Changes the gateway makes to a request body before it reaches CLIProxyAPI:
// the target model, its supported reasoning level and any required role translation.
// Nothing else is touched.

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Closest supported reasoning level, preferring the higher one on a tie. A
// level outside the known scale maps to the model's top level.
function nearestEffort(requested, supported) {
  if (supported.includes(requested)) return requested;
  const rank = EFFORT_ORDER.indexOf(requested);
  if (rank < 0) return supported[supported.length - 1];
  return [...supported].sort((a, b) => {
    const da = Math.abs(EFFORT_ORDER.indexOf(a) - rank);
    const db = Math.abs(EFFORT_ORDER.indexOf(b) - rank);
    return da - db || EFFORT_ORDER.indexOf(b) - EFFORT_ORDER.indexOf(a);
  })[0];
}

// Rewrites reasoning_effort / reasoning.effort to a level the model accepts,
// and removes it for a model without reasoning levels. `supported` of null
// means the model is unknown, so the request is left alone.
function clampEffort(body, supported) {
  if (!Array.isArray(supported)) return false;
  let changed = false;
  const fix = (holder, key) => {
    if (typeof holder?.[key] !== "string" || supported.includes(holder[key])) return;
    if (supported.length) holder[key] = nearestEffort(holder[key], supported);
    else delete holder[key];
    changed = true;
  };
  fix(body, "reasoning_effort");
  fix(body.reasoning, "effort");
  return changed;
}

// Body for one attempt on `model`. `raw` is returned untouched when nothing
// changes, so the bytes (and with them any prompt-cache prefix) are preserved.
function prepareBody(raw, model, { efforts = null, upstream = null } = {}) {
  const body = JSON.parse(raw.toString("utf8"));
  const target = upstream || model;
  let changed = body.model !== target;
  body.model = target;
  // Qwen Cloud rejects the developer role. Scope this to the selected API
  // route, not a model family (e.g. OpenRouter can also serve Qwen models).
  if (model.startsWith("qwen/")) {
    for (const messages of [body.messages, body.input]) {
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        if (message?.role !== "developer") continue;
        message.role = "system";
        changed = true;
      }
    }
  }
  changed = clampEffort(body, efforts) || changed;
  return changed ? Buffer.from(JSON.stringify(body), "utf8") : raw;
}

module.exports = { EFFORT_ORDER, nearestEffort, clampEffort, prepareBody };
