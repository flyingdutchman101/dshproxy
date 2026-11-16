const accounts = require("./accounts");
const app = require("./app");
const catalog = require("./catalog");
const daemon = require("./daemon");
const profile = require("./dsh/profile");
const settingsFile = require("./settings");
const { render } = require("./backend/config");
const { install } = require("./backend/install");
const { STATUS_PATH } = require("./gateway/server");
const fs = require("fs");
const { readLock, compareVersions } = require("./backend/updater");

const HELP = `dshgate ${app.version} - local model gateway for DeepSeek Harness

Usage:
  dshgate start                       Run the gateway (keep this window open)
  dshgate status                      Show accounts, API keys, lanes and the DeepSeek Harness state
  dshgate login <provider>            Sign in: ${Object.keys(accounts.PROVIDERS).join(", ")}
  dshgate accounts                    List signed-in accounts
  dshgate key set <provider> [region] Save an API key (read from standard input, never from the command line)
  dshgate key remove <provider>       Remove a saved API key
  dshgate key list                    List API-key providers and their regions
  dshgate models                      List the models that can be offered right now
  dshgate dsh apply [--dry-run]       Write the models into every DeepSeek Harness profile
  dshgate dsh status                  Show what DeepSeek Harness currently has
  dshgate dsh remove [--dry-run]      Remove dshgate's routes from DeepSeek Harness
  dshgate backend version             Show the CLIProxyAPI version in use
  dshgate backend rollback            Go back to the previous CLIProxyAPI version

Settings and data: ${settingsFile.homeDir()}`;

// Reads one line without echoing it when typed at a terminal; reads all of
// standard input when it is piped.
function readSecret(prompt) {
  const input = process.stdin;
  if (!input.isTTY) {
    return new Promise((resolve, reject) => {
      let text = "";
      input.setEncoding("utf8");
      input.on("data", (chunk) => (text += chunk));
      input.on("end", () => resolve(text.trim()));
      input.on("error", reject);
    });
  }
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    let text = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const done = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          done();
          resolve(text.trim());
          return;
        }
        if (char === "\u0003") {
          done();
          process.exit(130);
        }
        if (char === "\u0008" || char === "\u007f") text = text.slice(0, -1);
        else text += char;
      }
    };
    input.on("data", onData);
  });
}

async function runningStatus(origin) {
  try {
    const response = await fetch(`${origin}${STATUS_PATH}`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function printAccounts(state, out) {
  if (!state.accounts.length) {
    out("Accounts: none. Sign in with `dshgate login <provider>`.");
    return;
  }
  out("Accounts:");
  for (const account of state.accounts) out(`  ${account.label}: ${account.account}${account.disabled ? " (disabled)" : ""}`);
}

async function status(out) {
  const state = await app.snapshot();
  const live = await runningStatus(state.origin);
  out(live ? `Gateway: running on ${state.origin} since ${live.startedAt} (backend ${live.backend.name} ${live.backend.version}, PID ${live.backend.pid})` : `Gateway: not running. Start it with \`dshgate start\`. It will listen on ${state.origin}.`);
  printAccounts(state, out);
  const keys = Object.keys(state.readable);
  out(`API keys: ${keys.length ? keys.map((key) => `${key} (${state.readable[key].region})`).join(", ") : "none"}`);
  if (state.unreadable.length) out(`API keys that cannot be read (enter again with \`dshgate key set\`): ${state.unreadable.join(", ")}`);
  out("Lanes:");
  const cooling = new Map((live?.lanes || []).flatMap((lane) => lane.ladder).filter((rung) => rung.coolingUntil).map((rung) => [rung.model, rung.coolingUntil]));
  for (const [name, ladder] of Object.entries(state.settings.lanes)) {
    const rungs = ladder.map((model) => {
      if (!state.isAvailable(model)) return `${model} (no account or key)`;
      return cooling.has(model) ? `${model} (skipped until ${new Date(cooling.get(model)).toLocaleTimeString()})` : model;
    });
    out(`  ${name}: ${rungs.join(" -> ")}`);
  }
  const dsh = profile.state(state.origin);
  if (!dsh.profiles.length) out("DeepSeek Harness: no profiles found.");
  for (const item of dsh.profiles) {
    if (item.error) out(`DeepSeek Harness profile ${item.profile}: ${item.error}`);
    else if (!item.routes.length) out(`DeepSeek Harness profile ${item.profile}: not applied. Run \`dshgate dsh apply\`.`);
    else out(`DeepSeek Harness profile ${item.profile}: ${item.routes.reduce((sum, route) => sum + route.models, 0)} models${item.current ? "" : " (they point at another address; run `dshgate dsh apply`)"}`);
  }
}

// Everything the Windows app shows, as one JSON document. API key values are
// never included, only which providers have one.
async function statusJson() {
  const state = await app.snapshot();
  const live = await runningStatus(state.origin);
  const liveLanes = new Map((live?.lanes || []).map((lane) => [lane.name, new Map(lane.ladder.map((rung) => [rung.model, rung.coolingUntil]))]));
  const lock = app.currentLock(state.home);
  return {
    running: Boolean(live),
    origin: state.origin,
    startedAt: live?.startedAt ?? null,
    backend: live ? live.backend : { name: lock.name, version: lock.version, running: false, pid: null },
    backendLock: { version: lock.version, publishedAt: lock.publishedAt || null, previous: lock.previous ? lock.previous.version : null },
    update: live?.update || null,
    discovery: state.discovery,
    modelList: state.listed.map(({ id, name, account, api, contextWindow, maxTokens, efforts, isNew, offered, reason, created }) => ({ id, name, account, api, contextWindow, maxTokens, efforts, isNew, offered, reason, created })),
    suggestions: state.suggestions,
    home: state.home,
    accounts: state.accounts.map(({ provider, label, account, disabled, expired }) => ({ provider, label, account, disabled, expired })),
    loginProviders: Object.entries(accounts.PROVIDERS).map(([key, entry]) => ({ key, label: entry.label })),
    providers: Object.entries(catalog.API_PROVIDERS).map(([key, entry]) => ({
      key,
      label: entry.label,
      regions: Object.entries(entry.regions).map(([regionKey, region]) => ({ key: regionKey, label: region.label }))
    })),
    apiKeys: {
      readable: Object.entries(state.readable).map(([provider, entry]) => ({ provider, region: entry.region })),
      unreadable: state.unreadable
    },
    lanes: Object.entries(state.settings.lanes).map(([name, ladder]) => ({
      name,
      ladder: ladder.map((model) => ({ model, available: state.isAvailable(model), coolingUntil: liveLanes.get(name)?.get(model) ?? null }))
    })),
    models: state.models.map((model) => model.id),
    deepseekHarness: profile.state(state.origin)
  };
}

function reportApply(result, dryRun, out) {
  for (const item of result.profiles) {
    const counts = Object.entries(item.routes).map(([key, count]) => `${key} ${count}`).join(", ");
    const verb = dryRun ? (item.changed ? "would change" : "would not change") : item.changed ? "updated" : "already up to date";
    out(`${item.profile}: ${verb} (${counts || "no routes"})`);
    if (item.kept.length) out(`  kept while their API key cannot be read: ${item.kept.join(", ")}`);
  }
  if (result.credential.created) out(dryRun ? "Would add the DSHGATE_API_KEY credential reference." : "Added the DSHGATE_API_KEY credential reference.");
  else if (result.credential.reason !== "already present") out(`Credential reference not added: ${result.credential.reason}`);
  if (!dryRun && result.profiles.some((item) => item.changed)) out("Restart DeepSeek Harness to load the new routes.");
}

// Puts the previous backend version back in the lock file. Returns false when
// there is none (or it is older than the shipped version).
function rollbackLock(out) {
  const file = app.writableLockFile();
  const current = readLock(file);
  if (!current.previous || compareVersions(current.previous.version, app.shippedLock().version) < 0) {
    out("There is no previous backend version to go back to.");
    return false;
  }
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(current.previous, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
  out(`Back on CLIProxyAPI ${current.previous.version} (from ${current.version}).`);
  return true;
}

async function main(argv, out = console.log) {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((item) => item.startsWith("--")));
  const args = rest.filter((item) => !item.startsWith("--"));
  const dryRun = flags.has("--dry-run");

  switch (command) {
    case "start": {
      // Restarting after an update or rollback: stop and wait until the ports
      // are free, then start on the version now in the lock file. If that
      // version will not start, go back to the previous one.
      let running = null;
      let restarting = false;
      const launch = () => daemon.start({ print: out, restart: restartGateway }).then((started) => {
        running = started;
      });
      const startWithRetries = async () => {
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await launch();
            return;
          } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          }
        }
        throw lastError;
      };
      async function restartGateway() {
        if (restarting) return;
        restarting = true;
        try {
          out("Restarting the gateway...");
          await running.stop();
          try {
            await startWithRetries();
          } catch (error) {
            out(`The gateway did not start on the new backend version: ${error.message}`);
            const rolled = rollbackLock(out);
            if (!rolled) process.exit(1);
            await startWithRetries();
          }
        } catch (error) {
          out(`Restart failed: ${error.message}`);
          process.exit(1);
        } finally {
          restarting = false;
        }
      }
      await launch();
      const shutdown = () => {
        Promise.resolve(running.stop()).finally(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return new Promise(() => {});
    }
    case "status":
      if (flags.has("--json")) return out(JSON.stringify(await statusJson()));
      return status(out);
    case "accounts":
      return printAccounts(await app.snapshot(), out);
    case "login": {
      const state = await app.snapshot();
      const backend = await install(app.currentLock(state.home), state.paths.binDir, { log: out });
      fs.mkdirSync(state.authDir, { recursive: true });
      fs.writeFileSync(state.paths.config, render({ host: state.settings.host, port: state.settings.backendPort, authDir: state.authDir, requestRetry: state.settings.requestRetry, providers: state.readable }));
      const code = await accounts.login(args[0], { binary: backend.path, configPath: state.paths.config });
      if (code !== 0) throw new Error(`Sign-in ended with exit code ${code}.`);
      out("Signed in. Run `dshgate dsh apply` to offer the new models to DeepSeek Harness.");
      return undefined;
    }
    case "key": {
      const [action, provider, region] = args;
      if (action === "list") {
        const state = await app.snapshot();
        for (const [key, entry] of Object.entries(catalog.API_PROVIDERS)) {
          const saved = state.readable[key] ? `saved (${state.readable[key].region})` : state.unreadable.includes(key) ? "saved, cannot be read" : "not set";
          out(`${key}: ${entry.label} - ${saved}; regions: ${Object.keys(entry.regions).join(", ")}`);
        }
        return undefined;
      }
      if (action === "set") {
        if (!provider) throw new Error("Usage: dshgate key set <provider> [region]");
        const chosen = await app.saveProviderKey(provider, await readSecret(`API key for ${provider}: `), region, settingsFile.homeDir());
        out(`Saved the ${provider} key (region ${chosen}). Restart the gateway, then run \`dshgate dsh apply\`.`);
        return undefined;
      }
      if (action === "remove") {
        out(app.removeProviderKey(provider, settingsFile.homeDir()) ? `Removed the ${provider} key. Restart the gateway, then run \`dshgate dsh apply\`.` : `No ${provider} key was saved.`);
        return undefined;
      }
      throw new Error("Usage: dshgate key set|remove|list");
    }
    case "models": {
      const state = await app.snapshot();
      if (!state.models.length) out("No models yet. Sign in with `dshgate login <provider>` or add a key with `dshgate key set <provider>`.");
      for (const model of state.models) out(`${model.id}  ${model.name}`);
      return undefined;
    }
    case "dsh": {
      const [action] = args;
      const state = await app.snapshot();
      if (action === "apply") return reportApply(profile.apply(state.models, state.origin, profile.dshHome(), { dryRun, keepModelPrefixes: state.unreadable }), dryRun, out);
      if (action === "remove") {
        for (const item of profile.remove(profile.dshHome(), { dryRun })) out(`${item.profile}: ${item.removed.length ? `${dryRun ? "would remove" : "removed"} ${item.removed.join(", ")}` : "nothing to remove"}`);
        return undefined;
      }
      if (action === "status") {
        for (const item of profile.state(state.origin).profiles) out(`${item.profile}: ${item.error || (item.routes.length ? item.routes.map((route) => `${route.key} ${route.models} models at ${route.baseURL}`).join("; ") : "not applied")}`);
        return undefined;
      }
      throw new Error("Usage: dshgate dsh apply|status|remove [--dry-run]");
    }
    case "backend": {
      // Works without a running gateway, so a version that will not start
      // can still be undone.
      if (args[0] === "rollback") {
        if (!rollbackLock(out)) process.exitCode = 1;
        else out("Start dshgate again to use it.");
        return undefined;
      }
      if (args[0] === "version") {
        const lock = app.currentLock();
        out(`CLIProxyAPI ${lock.version}${lock.previous ? ` (previous ${lock.previous.version} kept)` : ""}`);
        return undefined;
      }
      throw new Error("Usage: dshgate backend version|rollback");
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return undefined;
    default:
      throw new Error(`Unknown command "${command}". Run \`dshgate help\`.`);
  }
}

module.exports = { main };
