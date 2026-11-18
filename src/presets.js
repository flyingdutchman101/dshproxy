// Routing presets: three ready-made sets of lanes, so the ladders can be
// switched as a whole. A lane is the same model ID in every preset; only the
// order and the members change.

const { DEFAULT_LANES } = require("./settings");

// Max performance: the strongest model each lane can reach, whatever it costs.
// Subscription models first (already paid for), API models as a last resort.
const PERFORMANCE = {
  main: ["gpt-6-astra", "claude-opus-5-5", "claude-fable-5-2", "gemini-4-carbon-high"],
  scout: ["claude-sonnet-5-5", "gpt-6.1-sol", "gemini-4-argon-high", "deepseek/deepseek-v4-pro"],
  builder: ["gpt-6-astra", "claude-sonnet-5-5", "claude-fable-5-2", "gemini-4-argon-high"],
  architect: ["claude-fable-5-2", "gpt-6.1-terra", "claude-opus-5-5", "gemini-4-carbon-high"],
  // No GPT here: main and builder start on GPT, and a review has to come from
  // another model family.
  reviewer: ["gemini-4-carbon-high", "claude-opus-5-5", "deepseek/deepseek-v4-pro"],
  google: ["gemini-4-carbon-high", "gemini-4-hydrogen-xhigh", "gemini-3.8-flash-high", "gemini-3.8-flash-tiered"]
};

// Cheap production: subscription quota first (no per-request bill), then the
// cheapest paid models. GPT and Opus are left out: they burn quota fastest.
const CHEAP = {
  main: ["claude-haiku-5-5", "gemini-3.8-flash-high", "gemini-4-carbon-high", "deepseek/deepseek-flash"],
  scout: ["gemini-3.8-flash-high", "claude-haiku-5-5", "deepseek/deepseek-flash", "qwen/qwen3.8-flash"],
  builder: ["claude-haiku-5-5", "gemini-4-argon-high", "deepseek/deepseek-v4-pro", "qwen/qwen3.8-flash"],
  architect: ["claude-sonnet-5-5", "gemini-4-carbon-high", "deepseek/deepseek-v4-pro", "gemini-4-argon-high"],
  reviewer: ["gemini-3.8-flash-high", "deepseek/deepseek-flash", "claude-haiku-5-5"],
  google: ["gemini-3.8-flash-high", "gemini-3.1-flash-lite", "gemini-3-flash", "gemini-4-hydrogen-xhigh"]
};

const PRESETS = {
  performance: {
    label: "Max performance",
    summary: "The strongest model each lane can reach, whatever it costs. Slowest and most quota-hungry.",
    lanes: PERFORMANCE
  },
  balanced: {
    label: "Balanced",
    summary: "Strong models first with cheaper ones as failover. The working default.",
    lanes: DEFAULT_LANES
  },
  cheap: {
    label: "Cheap production",
    summary: "Subscription quota first, then the cheapest paid models. Leaves GPT and Opus out.",
    lanes: CHEAP
  }
};

const names = () => Object.keys(PRESETS);

function get(name) {
  const preset = PRESETS[String(name || "").toLowerCase()];
  if (!preset) throw new Error(`Unknown routing preset "${name}". Use one of: ${names().join(", ")}.`);
  return preset;
}

// The same ladders, in any order of keys, compare equal.
function fingerprint(lanes) {
  const lanesObject = lanes && typeof lanes === "object" ? lanes : {};
  return JSON.stringify(Object.keys(lanesObject).sort().map((lane) => [lane, Array.isArray(lanesObject[lane]) ? lanesObject[lane] : []]));
}

// Which preset these ladders are, or "custom" once they have been edited.
function describe(lanes) {
  const wanted = fingerprint(lanes);
  for (const name of names()) {
    if (fingerprint(PRESETS[name].lanes) === wanted) return { name, label: PRESETS[name].label };
  }
  return { name: "custom", label: "Custom" };
}

module.exports = { PRESETS, names, get, describe };
