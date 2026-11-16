// The configuration file the gateway writes for CLIProxyAPI on every start.
// Layout: CLIProxyAPI config version 8.

const YAML = require("yaml");
const { API_PROVIDERS, providerRegion, providerModels } = require("../catalog");

// `providers` is { [providerKey]: { region, apiKey } } with readable keys only.
// `managementKey` switches the Management API on for loopback callers that
// send it; the backend replaces it with a hash when it starts. Without one the
// Management API is off.
function render({ host, port, authDir, requestRetry = 3, providers = {}, managementKey = "" }) {
  const config = {
    "config-version": 8,
    server: { host, port },
    management: { "allow-remote": false, "secret-key": managementKey, "disable-control-panel": true },
    routing: {
      strategy: "round-robin",
      "session-affinity": true,
      "session-affinity-ttl": "2h",
      retry: { "request-retry": requestRetry },
      // The gateway decides when a model sits out, so the backend must not
      // also black out a credential.
      cooldown: { "disable-cooling": true }
    },
    oauth: { "auth-dir": authDir },
    observability: {
      logs: { debug: false, "logging-to-file": false, "request-log": false },
      usage: { "usage-statistics-enabled": false }
    },
    plugins: { enabled: false }
  };

  const groups = Object.entries(providers)
    .filter(([key, value]) => API_PROVIDERS[key] && value?.apiKey)
    .map(([key, value]) => ({
      name: key,
      prefix: key,
      "base-url": providerRegion(key, value.region).baseUrl,
      keys: [{ "api-key": value.apiKey }],
      models: providerModels(key, value.region).map((model) => ({
        name: model.upstreamName,
        alias: model.upstreamName,
        "display-name": model.name,
        ...(model.efforts.length ? { thinking: { levels: model.efforts } } : {})
      }))
    }));
  if (groups.length) config["api-keys"] = { "openai-compatibility": groups };

  return `# Written by DSHProxy on every start. Edit ~/.dshproxy/settings.json instead.\n${YAML.stringify(config, { lineWidth: 0 })}`;
}

module.exports = { render };
