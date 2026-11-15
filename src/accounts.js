// Subscription accounts are CLIProxyAPI credential files in the auth folder.
// The gateway reads only what it needs to list them; it never reads, refreshes
// or rewrites tokens. Signing in is done by CLIProxyAPI's own login commands.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PROVIDERS = {
  codex: { label: "ChatGPT (Codex)", flag: "-codex-login" },
  claude: { label: "Claude", flag: "-claude-login" },
  antigravity: { label: "Gemini (Antigravity)", flag: "-antigravity-login" },
  kimi: { label: "Kimi", flag: "-kimi-login" }
};
const ALIASES = { gemini: "antigravity", chatgpt: "codex", gpt: "codex" };

function providerKey(name) {
  const key = String(name || "").toLowerCase();
  return PROVIDERS[key] ? key : ALIASES[key] || null;
}

function list(authDir) {
  let files;
  try {
    files = fs.readdirSync(authDir).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((file) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(authDir, file), "utf8"));
      const provider = String(data.type || "").toLowerCase();
      if (!PROVIDERS[provider]) return null;
      const expired = Date.parse(data.expired);
      return {
        file,
        provider,
        label: PROVIDERS[provider].label,
        account: String(data.email || data.login || file),
        disabled: Boolean(data.disabled),
        expired: Number.isFinite(expired) ? new Date(expired).toISOString() : null
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// Providers with at least one account that is not disabled.
function activeProviders(authDir) {
  return new Set(list(authDir).filter((account) => !account.disabled).map((account) => account.provider));
}

// Runs CLIProxyAPI's login for a provider in the current terminal. Resolves
// with the exit code.
function login(provider, { binary, configPath }) {
  const key = providerKey(provider);
  if (!key) return Promise.reject(new Error(`Unknown provider "${provider}". Use one of: ${Object.keys(PROVIDERS).join(", ")}.`));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["-config", configPath, PROVIDERS[key].flag], { cwd: path.dirname(binary), stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

module.exports = { PROVIDERS, providerKey, list, activeProviders, login };
