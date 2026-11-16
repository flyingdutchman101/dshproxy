// What the gateway knows about each model: which account or API key serves it,
// which DeepSeek Harness route it belongs on, its sizes and reasoning levels.
// Sizes and levels are from each provider's docs as of Nov 2026.

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const REASONING = ["low", "high", "max"];

// `account` is the `type` field of the CLIProxyAPI credential file that serves
// the model. `api` names the DeepSeek Harness route (see dsh/profile.js).
const subscription = (id, name, account, api, extra = {}) => ({
  id,
  name,
  account,
  api,
  contextWindow: 1000000,
  maxTokens: 128000,
  efforts: ALL_EFFORTS,
  ...extra
});

const SUBSCRIPTION_MODELS = [
  subscription("gpt-6-astra", "GPT 6 Astra", "codex", "openai", { contextWindow: 272000 }),
  subscription("gpt-6.1-sol", "GPT 6.1 Sol", "codex", "openai", { contextWindow: 272000 }),
  subscription("gpt-6.1-terra", "GPT 6.1 Terra", "codex", "openai", { contextWindow: 272000 }),
  subscription("gpt-6-luna", "GPT 6 Luna", "codex", "openai", { contextWindow: 272000 }),
  subscription("claude-fable-5-2", "Fable 5.2", "claude", "claude"),
  subscription("claude-fable-5-1", "Fable 5.1", "claude", "claude"),
  subscription("claude-opus-5-5", "Opus 5.5", "claude", "claude"),
  subscription("claude-sonnet-5-5", "Sonnet 5.5", "claude", "claude"),
  subscription("claude-haiku-5-5", "Haiku 5.5", "claude", "claude"),
  // Google rejects anything over 1,048,576 tokens and counts tokens differently
  // from the harness, so 900k leaves headroom for compaction.
  subscription("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)", "antigravity", "compat", { contextWindow: 900000, maxTokens: 65536, efforts: ["high"] }),
  subscription("gemini-4-argon-high", "Gemini 4 Argon (High)", "antigravity", "compat", { contextWindow: 900000, maxTokens: 65536, efforts: ["high"] }),
  subscription("gemini-4-carbon-high", "Gemini 4 Carbon (High)", "antigravity", "compat", { contextWindow: 900000, maxTokens: 65536, efforts: ["high"] }),
  // Claude served by a Google AI Pro/Ultra subscription. `upstream` is the ID
  // Antigravity expects; the gateway rewrites the request to it.
  subscription("ag-c55o-high", "Claude Opus 5.5 (High) via Google", "antigravity", "compat", { upstream: "claude-opus-5-5-high", efforts: ["high"] }),
  subscription("ag-c55s-high", "Claude Sonnet 5.5 (High) via Google", "antigravity", "compat", { upstream: "claude-sonnet-5-5-high", efforts: ["high"] }),
  subscription("kimi-k3", "Kimi K3", "kimi", "compat", { maxTokens: 65536, efforts: ["max"] }),
  subscription("kimi-k2.6", "Kimi K2.6", "kimi", "compat", { maxTokens: 262144, efforts: ["high"] })
];

const m = (name, displayName, contextWindow, maxTokens, efforts) => ({ name, displayName, contextWindow, maxTokens, efforts });

// API-key providers, served through CLIProxyAPI's openai-compatibility groups.
// Each provider is a model-ID prefix ("deepseek/deepseek-v4-pro"), so its
// models can never collide with a subscription model.
const API_PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    regions: { international: { label: "Default", baseUrl: "https://api.deepseek.com", residency: "China" } },
    models: [
      m("deepseek-v4-pro", "DeepSeek V4 Pro", 1000000, 128000, REASONING),
      m("deepseek-flash", "DeepSeek V4.1 Flash", 1000000, 128000, REASONING)
    ]
  },
  moonshot: {
    label: "Kimi API (Moonshot)",
    regions: {
      international: { label: "International", baseUrl: "https://api.moonshot.ai/v1", residency: "Singapore" },
      china: { label: "China", baseUrl: "https://api.moonshot.cn/v1", residency: "China" }
    },
    models: [
      m("kimi-k3.1-pro", "Kimi K3.1 Pro", 1048576, 65536, REASONING),
      m("kimi-k3", "Kimi K3 (API)", 1048576, 65536, REASONING)
    ]
  },
  zai: {
    label: "GLM (Z.ai)",
    regions: {
      international: { label: "International", baseUrl: "https://api.z.ai/api/paas/v4", residency: "Singapore" },
      codingplan: { label: "GLM Coding Plan", baseUrl: "https://api.z.ai/api/coding/paas/v4", residency: "Singapore" },
      china: { label: "China", baseUrl: "https://open.bigmodel.cn/api/paas/v4", residency: "China" }
    },
    models: [m("glm-5.3", "GLM-5.3", 1000000, 128000, REASONING)]
  },
  qwen: {
    label: "Qwen Cloud",
    // Token Plan keys (sk-sp-) only work on the Token Plan host; pay-as-you-go
    // keys use the region hosts. A region may list its own models.
    regions: {
      tokenplan: {
        label: "Token Plan (sk-sp- keys)",
        baseUrl: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
        residency: "Singapore",
        models: [
          m("qwen3.8-max", "Qwen3.8 Max", 991808, 131072, ["high"]),
          m("qwen3.8-flash", "Qwen3.8 Flash", 1000000, 65536, ["high"]),
          m("glm-5.3", "GLM-5.3 (Qwen Token Plan)", 1000000, 128000, REASONING),
          m("deepseek-v4-pro", "DeepSeek V4 Pro (Qwen Token Plan)", 1000000, 128000, REASONING)
        ]
      },
      singapore: { label: "Pay-as-you-go · Singapore", baseUrl: "https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1", residency: "Singapore" },
      china: { label: "Pay-as-you-go · China (Beijing)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", residency: "China" }
    },
    models: [
      m("qwen3.8-max", "Qwen3.8 Max", 991808, 131072, ["high"]),
      m("qwen3.8-flash", "Qwen3.8 Flash", 1000000, 65536, ["high"])
    ]
  },
  minimax: {
    label: "MiniMax",
    regions: {
      international: { label: "International", baseUrl: "https://api.minimax.io/v1", residency: "Not confirmed" },
      china: { label: "China", baseUrl: "https://api.minimax.cn/v1", residency: "China" }
    },
    models: [
      m("MiniMax-M3.1-Flash", "MiniMax M3.1 Flash", 1000000, 65536, ALL_EFFORTS),
      m("MiniMax-M3", "MiniMax M3", 1000000, 65536, ["high"])
    ]
  },
  mistral: {
    label: "Mistral (EU)",
    regions: {
      eu: { label: "EU", baseUrl: "https://api.eu.mistral.ai/v1", residency: "EU" },
      global: { label: "Global", baseUrl: "https://api.mistral.ai/v1", residency: "Not region-bound" }
    },
    models: [
      m("mistral-medium-3-5", "Mistral Medium 3.5", 256000, 32768, []),
      m("codestral-2508", "Codestral", 128000, 32768, [])
    ]
  },
  openrouter: {
    label: "OpenRouter",
    regions: { global: { label: "Default", baseUrl: "https://openrouter.ai/api/v1", residency: "Depends on the model's host" } },
    models: [
      m("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro (OpenRouter)", 1048576, 128000, REASONING),
      m("moonshotai/kimi-k3.1-pro", "Kimi K3.1 Pro (OpenRouter)", 1048576, 65536, REASONING),
      m("z-ai/glm-5.3", "GLM-5.3 (OpenRouter)", 1048576, 128000, REASONING),
      m("qwen/qwen3.8-max-0902", "Qwen3.8 Max (OpenRouter)", 1000000, 131072, ["high"]),
      m("minimax/minimax-m3.1-flash", "MiniMax M3.1 Flash (OpenRouter)", 1048576, 65536, ALL_EFFORTS),
      m("mistralai/mistral-medium-3-5", "Mistral Medium 3.5 (OpenRouter)", 262144, 32768, [])
    ]
  }
};

const LANE_PREFIX = "lane-";

function providerRegionKey(providerKey, regionKey) {
  const regions = API_PROVIDERS[providerKey].regions;
  return regions[regionKey] ? regionKey : Object.keys(regions)[0];
}

function providerRegion(providerKey, regionKey) {
  const provider = API_PROVIDERS[providerKey];
  return provider ? provider.regions[providerRegionKey(providerKey, regionKey)] : null;
}

// Picks the region a key belongs to when its prefix makes that unambiguous.
function regionForKey(providerKey, apiKey, regionKey) {
  if (providerKey === "qwen" && /^sk-sp-/.test(apiKey)) return "tokenplan";
  if (providerKey === "qwen" && regionKey === "tokenplan") return "singapore";
  return providerRegionKey(providerKey, regionKey);
}

const apiModel = (providerKey, model) => ({
  id: `${providerKey}/${model.name}`,
  name: model.displayName,
  provider: providerKey,
  upstreamName: model.name,
  api: "compat",
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  efforts: model.efforts
});

// Models a provider serves in the given region.
function providerModels(providerKey, regionKey) {
  const provider = API_PROVIDERS[providerKey];
  if (!provider) return [];
  const region = providerRegion(providerKey, regionKey);
  return (region.models || provider.models).map((model) => apiModel(providerKey, model));
}

function subscriptionModels() {
  return SUBSCRIPTION_MODELS.map((model) => ({ ...model }));
}

// Looks a model up by the ID clients send. API-key models are matched across
// every region, since the ID alone does not say which region is configured.
function findModel(id) {
  if (typeof id !== "string") return null;
  const direct = SUBSCRIPTION_MODELS.find((model) => model.id === id);
  if (direct) return direct;
  const slash = id.indexOf("/");
  const providerKey = slash > 0 ? id.slice(0, slash) : "";
  const provider = API_PROVIDERS[providerKey];
  if (!provider) return null;
  const name = id.slice(slash + 1);
  const lists = [provider.models, ...Object.values(provider.regions).map((region) => region.models || [])];
  const match = lists.flat().find((model) => model.name === name);
  return match ? apiModel(providerKey, match) : null;
}

const laneId = (name) => `${LANE_PREFIX}${name}`;
const laneName = (id) => (typeof id === "string" && id.startsWith(LANE_PREFIX) ? id.slice(LANE_PREFIX.length) : null);

// A lane is one model ID that stands for a ladder of real models. Its sizes
// are the smallest on the ladder, so a request sized for the lane fits every
// rung. It offers every reasoning level; the gateway maps the chosen level to
// the nearest one the serving rung accepts.
// `lookup(id)` can supply sizes from the model catalog; the hand-written list
// is used for anything it does not know.
function laneModels(lanes, lookup = () => null) {
  return Object.entries(lanes || {}).map(([name, ladder]) => {
    const known = ladder.map((id) => lookup(id) || findModel(id)).filter(Boolean);
    return {
      id: laneId(name),
      name: `Lane · ${name}`,
      lane: name,
      api: "lanes",
      contextWindow: known.length ? Math.min(...known.map((model) => model.contextWindow)) : 200000,
      maxTokens: known.length ? Math.min(...known.map((model) => model.maxTokens)) : 32000,
      efforts: ALL_EFFORTS
    };
  });
}

module.exports = {
  ALL_EFFORTS,
  API_PROVIDERS,
  SUBSCRIPTION_MODELS,
  subscriptionModels,
  providerModels,
  providerRegion,
  providerRegionKey,
  regionForKey,
  findModel,
  laneModels,
  laneId,
  laneName
};
