const accounts = require("./accounts");
const app = require("./app");
const catalog = require("./catalog");
const daemon = require("./daemon");
const profile = require("./dsh/profile");
const bundle = require("./dsh/bundle");
const settingsFile = require("./settings");
const { render } = require("./backend/config");
const { install } = require("./backend/install");
const { STATUS_PATH } = require("./gateway/server");
const presets = require("./presets");
const fs = require("fs");
const http = require("http");
const { PREFIX: CONTROL_PREFIX } = require("./control");
const { readLock, compareVersions } = require("./backend/updater");

// A restart after a backend update or rollback waits this long, at most, for
// a moment with no request in flight, and says so in the log this often.
const RESTART_WAIT_MS = 15 * 60 * 1000;
const RESTART_NOTE_MS = 60 * 1000;
// `dshproxy stop --when-idle` waits this long when it is not told.
const STOP_WAIT_SECONDS = 300;
const MAX_STOP_WAIT_SECONDS = 24 * 60 * 60;
// When the connection that carries the gateway's answer is lost, the command
// looks at the gateway itself for this long, at these intervals.
const LOST_ANSWER_MS = 3000;
const LOST_ANSWER_PAUSE_MS = 150;
// How long the stop command waits for the gateway's status before it asks.
const STOP_STATUS_MS = 2000;
const STOP_USAGE = `Usage: dshproxy stop --when-idle [--wait SECONDS]  (SECONDS: a whole number from 0 to ${MAX_STOP_WAIT_SECONDS}; default ${STOP_WAIT_SECONDS})`;

const HELP = `DeepSeekProxy (dshproxy) ${app.version} - local model gateway for DeepSeek Harness

Usage:
  dshproxy start                       Run the gateway (keep this window open)
  dshproxy stop --when-idle [--wait SECONDS]
                                       Stop the running gateway at a moment with no request in flight (default wait 300)
  dshproxy status                      Show accounts, API keys, lanes and the DeepSeek Harness state
  dshproxy login <provider>            Sign in: ${Object.keys(accounts.PROVIDERS).join(", ")}
  dshproxy accounts                    List signed-in accounts
  dshproxy accounts primary <provider> <account|none>
                                       Use one account of a provider first; the others take over when it is out of quota
  dshproxy key set <provider> [region] Save an API key (read from standard input, never from the command line)
  dshproxy key remove <provider>       Remove a saved API key
  dshproxy key list                    List API-key providers and their regions
  dshproxy key custom add|list|remove   Add a custom OpenAI-compatible endpoint (LiteLLM, One API, ...)
  dshproxy research help               Search Foreplay ads and list saved boards
  dshproxy voice help                  ElevenLabs voices, narration, transcription and voice changing
  dshproxy video help                  Quote benchmark videos, save provider keys, submit once, or check a job
  dshproxy models                      List the models that can be offered right now
  dshproxy dsh apply [--dry-run]       Write the models into every DeepSeek Harness profile
  dshproxy dsh verify                  Check that DeepSeek Harness has every route it needs
  dshproxy dsh status                  Show what DeepSeek Harness currently has
  dshproxy dsh remove [--dry-run]      Remove DSHProxy's routes from DeepSeek Harness
  dshproxy dsh bundle status [--json]  Show whether the video plugin is installed in DeepSeek Harness (reads only)
  dshproxy dsh bundle install [--json] Install the video plugin with DeepSeek Harness's own command (quit DeepSeek Harness first)
  dshproxy backend version             Show the CLIProxyAPI version in use
  dshproxy backend update              Ask the running gateway to update CLIProxyAPI
  dshproxy backend rollback            Go back to the previous CLIProxyAPI version
  dshproxy preset list                 Show the routing presets and the active one
  dshproxy preset use <name>           Switch all lanes to a preset: performance, balanced, cheap

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

const requests = (count) => `${count} request${count === 1 ? "" : "s"}`;
const span = (ms) => (ms >= 60000 && ms % 60000 === 0 ? `${ms / 60000} min` : `${Math.round(ms / 1000)} s`);

// Stops a running gateway (what daemon.start returned) for a restart without
// cutting requests: it waits for a moment with nothing in flight, noting the
// wait in the log every `noteMs`. After `limitMs` it stops anyway and logs how
// many requests that cut. Resolves { cut } once the gateway has stopped.
async function stopForRestart(gateway, { limitMs = RESTART_WAIT_MS, noteMs = RESTART_NOTE_MS } = {}) {
  const busy = gateway.inFlight();
  if (busy) gateway.log(`Restart requested with ${requests(busy)} in flight: waiting for a moment with none, at most ${span(limitMs)}.`);
  let waited = 0;
  while (waited < limitMs) {
    const step = Math.min(noteMs, limitMs - waited);
    const result = await gateway.stop({ whenIdle: true, waitMs: step });
    if (result.stopped) return { cut: 0 };
    waited += step;
    if (waited < limitMs) gateway.log(`Restart is waiting for ${requests(result.inFlight)} in flight (${span(waited)} so far, at most ${span(limitMs)}).`);
  }
  const cut = gateway.inFlight();
  await gateway.stop();
  if (cut) gateway.log(`Restarting after waiting ${span(limitMs)}: ${requests(cut)} in flight ${cut === 1 ? "was" : "were"} cut.`);
  return { cut };
}

// One look at the gateway's address: "running" when its status is answered,
// "closed" when nothing listens there, "unclear" for anything else: no answer
// within `waitMs`, or one that is not a gateway's status. A gateway that is
// busy can be slow to answer, so "unclear" is never taken for "closed".
function lookAt(origin, waitMs = 1000) {
  return new Promise((resolve) => {
    const request = http.get(`${origin}${STATUS_PATH}`, { agent: false, timeout: waitMs }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let status = null;
        try {
          status = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          // not a gateway's status
        }
        resolve(response.statusCode === 200 && status !== null && typeof status === "object" ? "running" : "unclear");
      });
      response.on("error", () => resolve("unclear"));
      response.on("close", () => resolve("unclear"));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", (error) => resolve(error.code === "ECONNREFUSED" ? "closed" : "unclear"));
  });
}

// What became of a gateway whose answer to the stop call was lost with its
// connection. A gateway that stops closes its port and removes its control
// token before it answers, so both gone means "stopped"; one that answers its
// status is "running". Looks for a few seconds, because a gateway can be in
// the middle of stopping, and says "unknown" when neither shows by then.
async function afterLostAnswer(origin, tokenFile) {
  const deadline = Date.now() + LOST_ANSWER_MS;
  for (;;) {
    const seen = await lookAt(origin);
    if (seen === "running") return "running";
    if (seen === "closed" && !fs.existsSync(tokenFile)) return "stopped";
    if (Date.now() >= deadline) return "unknown";
    await new Promise((resolve) => setTimeout(resolve, LOST_ANSWER_PAUSE_MS));
  }
}

// The control token the gateway wrote to its file when it started, or null
// when the file is missing or does not hold one.
function controlToken(tokenFile) {
  try {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

// Asks the running gateway, over its control interface, to stop at a moment
// with nothing in flight. Resolves { status, text } of its answer, and rejects
// with the code ANSWER_LOST when the connection is lost before the whole
// answer has arrived. The token goes into the request header and nowhere else.
//
// The connection is not kept for another request (`agent: false`), so it is
// closed from this side once the answer has been read. A gateway that has
// stopped waits for that before its process ends, and so never ends while its
// answer is still on the way.
function askToStop(origin, token, waitSeconds) {
  const body = JSON.stringify({ waitSeconds });
  return new Promise((resolve, reject) => {
    const lost = () => reject(Object.assign(new Error("The connection to the gateway was lost before it answered."), { code: "ANSWER_LOST" }));
    const request = http.request(`${origin}${CONTROL_PREFIX}stop`, { method: "POST", agent: false, headers: { "x-dshproxy-token": token, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 64 * 1024) chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", lost);
      response.on("close", lost);
    });
    request.on("error", lost);
    // The gateway answers within the wait, plus the time its backend takes to exit.
    request.setTimeout((waitSeconds + 60) * 1000, () => request.destroy());
    request.end(body);
  });
}

// One call to the running gateway's control interface. Resolves the JSON it
// answers; rejects with one sentence for anything else. The token goes into
// the request header and nowhere else.
function askGateway(origin, token, name, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}${CONTROL_PREFIX}${name}`, { method: "POST", agent: false, headers: { "x-dshproxy-token": token, "content-type": "application/json", "content-length": 2 } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let value = null;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          // reported below
        }
        if (response.statusCode === 401) reject(new Error("The running gateway did not accept the control token; it may use another data folder. Nothing was changed."));
        else if (response.statusCode === 404) reject(new Error("The running gateway is an older DSHProxy that cannot do this. Nothing was changed."));
        else if (response.statusCode !== 200 || value === null || typeof value !== "object") reject(new Error(`The running gateway refused: ${value?.error || `HTTP ${response.statusCode}`}`));
        else resolve(value);
      });
      response.on("error", () => reject(new Error("The connection to the gateway was lost before it answered.")));
    });
    request.on("error", (error) => reject(new Error(`The gateway could not be reached (${error.code || error.message}).`)));
    request.setTimeout(timeoutMs, () => request.destroy(new Error("no answer in time")));
    request.end("{}");
  });
}

// `dshproxy backend update`: the running gateway looks for a newer
// CLIProxyAPI and applies it, as the Windows app's Update... button does.
async function updateBackend(out) {
  const origin = settingsFile.origin(settingsFile.load());
  if (await lookAt(origin, STOP_STATUS_MS) === "closed") throw new Error(`The gateway is not running on ${origin}. Nothing was changed.`);
  const tokenFile = settingsFile.paths().controlToken;
  const token = controlToken(tokenFile);
  if (!token) throw new Error(`${tokenFile} cannot be read, so the running gateway cannot be asked. Nothing was changed.`);
  const checked = await askGateway(origin, token, "update/check", 60 * 1000);
  if (checked.error) throw new Error(`DSHProxy could not check for a newer CLIProxyAPI: ${checked.error} Nothing was changed.`);
  if (!checked.available) return out(`CLIProxyAPI ${checked.current} is up to date.`);
  out(`CLIProxyAPI ${checked.latest} is available (running ${checked.current}). Downloading it, checking it and trying it on a spare port...`);
  const applied = await askGateway(origin, token, "update/apply", 30 * 60 * 1000);
  if (!applied.ok) throw new Error(applied.message || "The update was not applied.");
  out(`${applied.message} The gateway restarts on it now.`);
  return undefined;
}

function printAccounts(state, out) {
  if (!state.accounts.length) {
    out("Accounts: none. Sign in with `dshproxy login <provider>`.");
    return;
  }
  out("Accounts:");
  for (const account of state.accounts) out(`  ${account.label}: ${account.account}${account.disabled ? " (disabled)" : ""}${state.settings.primary[account.provider] === account.file ? " (primary)" : ""}`);
}

async function status(out) {
  const state = await app.snapshot();
  const live = await runningStatus(state.origin);
  out(live ? `Gateway: running on ${state.origin} since ${live.startedAt} (backend ${live.backend.name} ${live.backend.version}, PID ${live.backend.pid})` : `Gateway: not running. Start it with \`dshproxy start\`. It will listen on ${state.origin}.`);
  if (Number.isInteger(live?.inFlight)) out(`Requests in flight: ${live.inFlight}`);
  printAccounts(state, out);
  const keys = Object.keys(state.readable);
  out(`API keys: ${keys.length ? keys.map((key) => `${key} (${state.readable[key].region})`).join(", ") : "none"}`);
  if (state.unreadable.length) out(`API keys that cannot be read (enter again with \`dshproxy key set\`): ${state.unreadable.join(", ")}`);
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
    else if (!item.routes.length) out(`DeepSeek Harness profile ${item.profile}: not applied. Run \`dshproxy dsh apply\`.`);
    else out(`DeepSeek Harness profile ${item.profile}: ${item.routes.reduce((sum, route) => sum + route.models, 0)} models${item.current ? "" : " (they point at another address; run `dshproxy dsh apply`)"}`);
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
    // Requests the gateway is serving right now; null when it is not running
    // or is a version that does not count them.
    inFlight: Number.isInteger(live?.inFlight) ? live.inFlight : null,
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
    routing: {
      active: presets.describe(state.settings.lanes),
      presets: presets.names().map((name) => ({ name, label: presets.get(name).label, summary: presets.get(name).summary }))
    },
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
  if (result.credential.created) out(dryRun ? "Would add the DSHPROXY_API_KEY credential reference." : "Added the DSHPROXY_API_KEY credential reference.");
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
  if (argv[0] === 'self-update') return require('./self-update/command').run(argv.slice(1), out);
  // Offline media quotes must not migrate, read, or modify the user's chat settings.
  // `video key set` reads its key from standard input, like `key set` below.
  // On macOS the data folder is private to this account (spec 0014, design 3),
  // for every command that may use it, video commands included.
  if (process.platform === "darwin") {
    try {
      fs.chmodSync(settingsFile.homeDir(), 0o700);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (argv[0] === 'research') return require('./research/command').run(argv.slice(1), out);
  if (argv[0] === "voice") return require('./voice/command').run(argv.slice(1), out);
  if (argv[0] === "video") return require("./video/command").run(argv.slice(1), out, { readSecret });
  // Only the default data folder is migrated; a DSHPROXY_HOME the user set is
  // used as given.
  if (!process.env.DSHPROXY_HOME) {
    const moved = settingsFile.migrateHome();
    if (moved.moved) out(`Moved the data folder from ${moved.from} to ${settingsFile.homeDir()}.`);
  }
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
      const launch = () => daemon.start({ print: out, restart: restartGateway, exit: () => process.exit(0) }).then((started) => {
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
          // Waits for a moment with no request in flight, so no session is cut.
          await stopForRestart(running);
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
    case "stop": {
      // Only the stop that waits for an idle moment exists: nothing here stops
      // a gateway at once.
      let whenIdle = false;
      let wait = null;
      for (let index = 0; index < rest.length; index += 1) {
        const value = rest[index + 1] || "";
        if (rest[index] === "--when-idle" && !whenIdle) whenIdle = true;
        else if (rest[index] === "--wait" && wait === null && /^\d{1,5}$/.test(value) && Number(value) <= MAX_STOP_WAIT_SECONDS) {
          wait = Number(value);
          index += 1;
        } else throw new Error(STOP_USAGE);
      }
      if (!whenIdle) throw new Error(STOP_USAGE);
      // The gateway is found as `status` finds it: at the address in the settings.
      const origin = settingsFile.origin(settingsFile.load());
      // Not running is said only when nothing listens there. A gateway that
      // is slow to give its status, or gives one that cannot be read, is
      // asked to stop all the same: its answer to that settles it.
      const seen = await lookAt(origin, STOP_STATUS_MS);
      if (seen === "closed") throw new Error(`The gateway is not running on ${origin}. Nothing was stopped.`);
      const tokenFile = settingsFile.paths().controlToken;
      const token = controlToken(tokenFile);
      if (!token && seen === "running") throw new Error(`${tokenFile} cannot be read, so the running gateway cannot be asked. Nothing was stopped.`);
      if (!token) throw new Error(`The gateway on ${origin} did not give its status within ${STOP_STATUS_MS / 1000} seconds; it may be busy. ${tokenFile} cannot be read, so it cannot be asked to stop. Nothing was stopped.`);
      let answer;
      try {
        answer = await askToStop(origin, token, wait ?? STOP_WAIT_SECONDS);
      } catch (error) {
        if (error.code !== "ANSWER_LOST") throw error;
        // No answer does not mean no stop: the gateway itself shows which.
        const became = await afterLostAnswer(origin, tokenFile);
        if (became === "stopped") return out(JSON.stringify({ stopped: true }));
        if (became === "running") throw new Error(`The connection to the gateway was lost before it answered, and it is still running on ${origin}. Nothing was stopped.`);
        throw new Error("The gateway's answer did not arrive: the connection was lost, and it is not known whether the gateway stopped. Check with `dshproxy status`.");
      }
      if (answer.status === 404) throw new Error("The running gateway is an older DSHProxy that cannot stop when idle. Nothing was stopped.");
      if (answer.status === 401) throw new Error("The running gateway did not accept the control token; it may use another data folder. Nothing was stopped.");
      if (answer.status !== 200) throw new Error(`The running gateway refused to stop when idle (HTTP ${answer.status}). Nothing was stopped.`);
      let result = null;
      try {
        result = JSON.parse(answer.text);
      } catch {
        // reported below
      }
      if (result?.stopped === true) return out(JSON.stringify({ stopped: true }));
      if (result?.stopped !== false || !Number.isInteger(result.inFlight) || result.inFlight < 0) throw new Error("DSHProxy did not understand the gateway's answer, so it is not known whether it stopped. Check with `dshproxy status`.");
      out(JSON.stringify({ stopped: false, inFlight: result.inFlight }));
      process.exitCode = 2;
      return undefined;
    }
    case "status":
      if (flags.has("--json")) return out(JSON.stringify(await statusJson()));
      return status(out);
    case "accounts": {
      const state = await app.snapshot();
      if (args[0] !== "primary") return printAccounts(state, out);
      // dshproxy accounts primary <provider> <account|none>
      const provider = accounts.providerKey(args[1]);
      const wanted = args[2];
      const label = accounts.PROVIDERS[provider]?.label;
      if (!label || !wanted) throw new Error(`Usage: dshproxy accounts primary <${Object.keys(accounts.PROVIDERS).join("|")}> <account|none>`);
      const current = settingsFile.load();
      if (wanted === "none") {
        delete current.primary[provider];
        settingsFile.save(current);
        out(`${label} has no primary account now: its accounts take turns.`);
      } else {
        const account = state.accounts.find((item) => item.provider === provider && (item.account === wanted || item.file === wanted));
        if (!account) throw new Error(`No ${label} account "${wanted}". Run \`dshproxy accounts\` to list them.`);
        current.primary[provider] = account.file;
        settingsFile.save(current);
        out(`${account.account} is the primary ${label} account. It is used until it is out of quota; then the provider's other accounts take over.`);
      }
      out("If the gateway is running, restart it (Stop, then Start in the app) to apply this, or use Make primary on the Accounts page instead.");
      return undefined;
    }
    case "login": {
      const state = await app.snapshot();
      const backend = await install(app.currentLock(state.home), state.paths.binDir, { log: out });
      fs.mkdirSync(state.authDir, { recursive: true });
      fs.writeFileSync(state.paths.config, render({ host: state.settings.host, port: state.settings.backendPort, authDir: state.authDir, providers: state.readable }));
      const code = await accounts.login(args[0], { binary: backend.path, configPath: state.paths.config });
      if (code !== 0) throw new Error(`Sign-in ended with exit code ${code}.`);
      out("Signed in. Run `dshproxy dsh apply` to offer the new models to DeepSeek Harness.");
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
        if (!provider) throw new Error("Usage: dshproxy key set <provider> [region]");
        const chosen = await app.saveProviderKey(provider, await readSecret(`API key for ${provider}: `), region, settingsFile.homeDir());
        out(`Saved the ${provider} key (region ${chosen}). Restart the gateway, then run \`dshproxy dsh apply\`.`);
        return undefined;
      }
      if (action === "remove") {
        out(app.removeProviderKey(provider, settingsFile.homeDir()) ? `Removed the ${provider} key. Restart the gateway, then run \`dshproxy dsh apply\`.` : `No ${provider} key was saved.`);
        return undefined;
      }
      if (action === "custom") {
        const [sub, name, baseUrl, modelsArg] = args.slice(1);
        if (sub === "list" || sub === undefined) {
          const state = await app.snapshot();
          if (!state.custom.length) out("No custom endpoints. Add one: dshproxy key custom add <name> <base-url> <model[,model...]>");
          for (const endpoint of state.custom) out(`${endpoint.name}: ${endpoint.baseUrl} - models: ${endpoint.models.join(", ")}`);
          for (const missing of state.customUnreadable) out(`${missing}: saved, cannot be read`);
          return undefined;
        }
        if (sub === "add") {
          if (!name || !baseUrl || !modelsArg) throw new Error("Usage: dshproxy key custom add <name> <base-url> <model[,model...]>  (the key is read from standard input)");
          const models = String(modelsArg).split(",").map((item) => item.trim()).filter(Boolean);
          const saved = await app.saveCustom({ name, baseUrl, models, apiKey: await readSecret(`API key for ${name}: `) }, settingsFile.homeDir());
          out(`Saved the ${saved} endpoint (${models.length} model${models.length === 1 ? "" : "s"}). Restart the gateway, then run \`dshproxy dsh apply\`.`);
          return undefined;
        }
        if (sub === "remove") {
          out(app.removeCustom(name, settingsFile.homeDir()) ? `Removed the ${name} endpoint. Restart the gateway, then run \`dshproxy dsh apply\`.` : `No ${name} endpoint was saved.`);
          return undefined;
        }
        throw new Error("Usage: dshproxy key custom add|list|remove");
      }
      throw new Error("Usage: dshproxy key set|remove|list|custom");
    }
    case "models": {
      const state = await app.snapshot();
      if (!state.models.length) out("No models yet. Sign in with `dshproxy login <provider>` or add a key with `dshproxy key set <provider>`.");
      for (const model of state.models) out(`${model.id}  ${model.name}`);
      return undefined;
    }
    case "dsh": {
      const [action] = args;
      // The video plugin in DeepSeek Harness. Neither command reads DSHProxy's
      // settings, accounts or keys, so they come before the snapshot.
      if (action === "bundle") {
        const json = flags.has("--json");
        if (args[1] === "status") {
          const found = await bundle.state();
          out(json ? JSON.stringify(found) : bundle.describe(found));
          return undefined;
        }
        if (args[1] === "install") {
          const result = await bundle.install();
          out(json ? JSON.stringify(result) : result.message);
          if (!result.ok) process.exitCode = 1;
          return undefined;
        }
        throw new Error("Usage: dshproxy dsh bundle status|install [--json]");
      }
      const state = await app.snapshot();
      if (action === "apply") return reportApply(profile.apply(app.profileModels(state), state.origin, profile.dshHome(), { dryRun, keepModelPrefixes: state.unreadable, lanes: state.settings.lanes }), dryRun, out);
      if (action === "remove") {
        for (const item of profile.remove(profile.dshHome(), { dryRun })) out(`${item.profile}: ${item.removed.length ? `${dryRun ? "would remove" : "removed"} ${item.removed.join(", ")}` : "nothing to remove"}`);
        return undefined;
      }
      if (action === "verify") {
        const report = profile.verify({ origin: state.origin, lanes: state.settings.lanes, models: app.profileModels(state).map((model) => ({ id: model.id, api: model.api })), home: profile.dshHome() });
        for (const item of report.profiles) {
          out(`${item.profile}: ${item.problems.length ? "NOT READY" : "ready"}`);
          for (const problem of item.problems) out(`  - ${problem}`);
        }
        for (const problem of report.credential) out(`credentials: ${problem}`);
        if (report.ok) out("DeepSeek Harness has every DSHProxy route it needs; restart it if the model list is stale.");
        else process.exitCode = 1;
        return undefined;
      }
      if (action === "status") {
        for (const item of profile.state(state.origin).profiles) out(`${item.profile}: ${item.error || (item.routes.length ? item.routes.map((route) => `${route.key} ${route.models} models at ${route.baseURL}`).join("; ") : "not applied")}`);
        return undefined;
      }
      throw new Error("Usage: dshproxy dsh apply|verify|status|remove [--dry-run] | dshproxy dsh bundle status|install [--json]");
    }
    case "backend": {
      // Works without a running gateway, so a version that will not start
      // can still be undone.
      if (args[0] === "rollback") {
        if (!rollbackLock(out)) process.exitCode = 1;
        else out("Start DSHProxy again to use it.");
        return undefined;
      }
      if (args[0] === "update") return updateBackend(out);
      if (args[0] === "version") {
        const lock = app.currentLock();
        out(`CLIProxyAPI ${lock.version}${lock.previous ? ` (previous ${lock.previous.version} kept)` : ""}`);
        return undefined;
      }
      throw new Error("Usage: dshproxy backend version|update|rollback");
    }
    case "preset": {
      const [action, name] = args;
      if (action === "list" || action === undefined) {
        const state = await app.snapshot();
        const active = presets.describe(state.settings.lanes);
        for (const presetName of presets.names()) {
          const preset = presets.get(presetName);
          out(`${presetName === active.name ? "*" : " "} ${presetName.padEnd(12)} ${preset.label}`);
          out(`    ${preset.summary}`);
          for (const [lane, ladder] of Object.entries(preset.lanes)) out(`    ${`${lane}:`.padEnd(11)} ${ladder.join(" > ")}`);
        }
        out(`Active: ${active.name}. Use \`dshproxy preset use <name>\` to switch.`);
        return undefined;
      }
      if (action === "use") {
        const preset = presets.get(name);
        const current = settingsFile.load();
        // Copied so later edits cannot change the preset table.
        current.lanes = JSON.parse(JSON.stringify(preset.lanes));
        settingsFile.save(current);
        out(`Routing preset: ${preset.label}.`);
        out("If the gateway is running, restart it (Stop, then Start in the app) so it uses the new ladders, then run `dshproxy dsh apply`.");
        return undefined;
      }
      throw new Error("Usage: dshproxy preset list | dshproxy preset use <performance|balanced|cheap>");
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return undefined;
    default:
      throw new Error(`Unknown command "${command}". Run \`dshproxy help\`.`);
  }
}

module.exports = { main, stopForRestart };
