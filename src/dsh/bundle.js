// Whether DSHProxy's video plugin (integrations/dsh-video) is installed in
// DeepSeek Harness's `desktop` profile, and installing it.
//
// `state` only reads. `install` runs DeepSeek Harness's own command once:
//   <Harness>\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add "<folder>"
// Nothing here writes a profile's package.json, node_modules or lock file:
// only that command does.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync, spawn } = require("child_process");
const YAML = require("yaml");
const { dshHome } = require("./profile");
const settingsFile = require("../settings");

const PROFILE = "desktop";
const PACKAGE = "@local/dshproxy-video";
const ENTRY_ID = "dshproxy-video";
const HARNESS = "DeepSeek Harness";
const PROCESS_NAME = `${HARNESS}.exe`;
const COMMAND = ["resources", "runtime", "cli", "bin", "dsh.cmd"];
const REGISTRY_KEY = "HKCU\\Software\\Classes\\dsh\\shell\\open\\command";
const INSTALL_MS = 120000;
const PROCESS_LIST_MS = 20000;
// How long a stopped command gets to let go of its output.
const STOPPED_GRACE_MS = 5000;
const KEPT_OUTPUT = 256 * 1024;
// A `.cmd` file can only be started through cmd.exe, which acts on these even
// inside quotes (or, with them, ends the quotes). A path that has one is
// refused, never escaped.
const UNSAFE = /[%"^&|<>!\r\n\0]/;
const UNSAFE_NAMES = "% \" ^ & | < > ! or a line break";
const SWITCHED_OFF = `The video plugin is switched off in ${HARNESS}. Switch it on under Plugins in ${HARNESS}; DSHProxy leaves it as you set it.`;

const system32 = (name) => path.join(process.env.SystemRoot || "C:\\Windows", "System32", name);
const firstLine = (text) => String(text || "").split(/\r?\n/)[0].trim();
// Resolved, with either slash, without regard to case.
const pathKey = (item) => path.resolve(item).replace(/[\\/]+$/, "").toLowerCase();
const samePath = (a, b) => pathKey(a) === pathKey(b);
const inside = (item, dir) => pathKey(item).startsWith(`${pathKey(dir)}\\`);
const commandIn = (dir) => path.join(dir, ...COMMAND);

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ where Harness is

// The command line registered for dsh: links, or null.
function registeredCommand() {
  try {
    const text = execFileSync(system32("reg.exe"), ["query", REGISTRY_KEY, "/ve"], { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const found = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(text);
    return found ? found[1].trim() : null;
  } catch {
    return null;
  }
}

// The DeepSeek Harness program folder that holds its command, or null:
// %DSHPROXY_HARNESS_DIR% when set (then nothing else is tried), else
// %LOCALAPPDATA%\Programs\DeepSeek Harness, else the folder of the program
// registered for dsh: links.
function locateHarness({ env = process.env, registry = registeredCommand } = {}) {
  const usable = (dir) => (dir && isFile(commandIn(dir)) ? path.resolve(dir) : null);
  if (env.DSHPROXY_HARNESS_DIR) return usable(env.DSHPROXY_HARNESS_DIR);
  const usual = env.LOCALAPPDATA ? usable(path.join(env.LOCALAPPDATA, "Programs", HARNESS)) : null;
  if (usual) return usual;
  let registered = null;
  try {
    registered = registry();
  } catch { /* no such key */ }
  const program = /^\s*"([^"]+)"/.exec(registered || "") || /^\s*(\S+\.exe)/i.exec(registered || "");
  return program ? usable(path.dirname(program[1])) : null;
}

// ------------------------------------------------------------ running processes

// One PowerShell call. Each DeepSeek Harness process is a line `P|<program
// path>`; the last line proves the list is whole.
const PROCESS_SCRIPT = `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter 'Name=''${PROCESS_NAME}''' | ForEach-Object { 'P|' + $_.ExecutablePath }; 'END'`;

function harnessProcesses() {
  return new Promise((resolve, reject) => {
    execFile(system32(path.join("WindowsPowerShell", "v1.0", "powershell.exe")), ["-NoProfile", "-NonInteractive", "-Command", PROCESS_SCRIPT], { windowsHide: true, timeout: PROCESS_LIST_MS }, (error, stdout) => {
      const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (error || lines.pop() !== "END") return reject(new Error("the process list could not be read"));
      return resolve(lines.filter((line) => line.startsWith("P|")).map((line) => ({ name: PROCESS_NAME, path: line.slice(2).trim() || null })));
    });
  });
}

// { running, readable }. A list that cannot be read counts as running, and so
// does a Harness process whose program path Windows does not give.
async function harnessRunning(processes, harnessDir) {
  let list;
  try {
    list = await processes();
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) return { running: true, readable: false };
  const running = list.some((item) => String(item?.name || "").toLowerCase() === PROCESS_NAME.toLowerCase() && (!item.path || inside(item.path, harnessDir)));
  return { running, readable: true };
}

// ------------------------------------------------------------ reading the profile

// { exists, pkg, error }: `error` is a short reason the file is of no use.
function readManifest(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return error.code === "ENOENT" ? { exists: false, pkg: null, error: null } : { exists: true, pkg: null, error: firstLine(error.message) };
  }
  try {
    const pkg = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return { exists: true, pkg: null, error: "it is not a JSON object" };
    return { exists: true, pkg, error: null };
  } catch (error) {
    return { exists: true, pkg: null, error: firstLine(error.message) };
  }
}

// { disabled, error }: what one patch file says about the entry
// `id: dshproxy-video`, wherever it sits: `disabled` is true or false as the
// file's last such entry sets it, and null when the file does not say (no
// file, no entry, or an entry without `disabled`).
function readPatch(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return error.code === "ENOENT" ? { disabled: null, error: null } : { disabled: null, error: firstLine(error.message) };
  }
  try {
    const doc = YAML.parseDocument(text);
    if (doc.errors.length) return { disabled: null, error: firstLine(doc.errors[0].message) };
    let disabled = null;
    YAML.visit(doc, {
      Map(_key, node) {
        if (node.get("id") === ENTRY_ID && typeof node.get("disabled") === "boolean") disabled = node.get("disabled");
      }
    });
    return { disabled, error: null };
  } catch (error) {
    return { disabled: null, error: firstLine(error.message) };
  }
}

// The profile's own patch, then the one in the Harness home, which applies to
// every profile after it: where both say whether the plugin is disabled, the
// later one wins. { disabled, error }: `error` names the first file that
// cannot be read.
function readPatches(files) {
  let disabled = false;
  let error = "";
  for (const file of files) {
    const patch = readPatch(file);
    if (patch.error && !error) error = `${file} cannot be read (${patch.error}), so it is not known whether the video plugin is switched on. Repair that file, then try again.`;
    if (patch.disabled !== null) disabled = patch.disabled;
  }
  return { disabled, error };
}

// The folder a `link:` dependency points at. A relative path is relative to
// the profile folder; `~` is the user's home folder.
function linkTarget(spec, profileDir) {
  if (typeof spec !== "string" || !spec.startsWith("link:")) return null;
  let target = spec.slice("link:".length);
  if (target === "~" || /^~[\\/]/.test(target)) target = path.join(os.homedir(), target.slice(1));
  return path.resolve(profileDir, target);
}

// ------------------------------------------------------------ state

// Everything from outside, each with its real default.
function context(deps = {}) {
  const env = deps.env || process.env;
  const root = path.resolve(deps.root || path.join(__dirname, "..", ".."));
  const harnessDir = deps.harnessDir === undefined ? locateHarness({ env, registry: deps.registry }) : deps.harnessDir;
  return {
    env,
    home: path.resolve(deps.home || dshHome()),
    // Used only when it holds the command; otherwise Harness is not found.
    harnessDir: harnessDir && isFile(commandIn(harnessDir)) ? path.resolve(harnessDir) : null,
    folder: path.join(root, "integrations", "dsh-video"),
    processes: deps.processes || harnessProcesses,
    run: deps.run || runCommand,
    timeoutMs: deps.timeoutMs || INSTALL_MS,
    logFile: deps.logFile || path.join(settingsFile.homeDir(), "dsh-bundle-install.log")
  };
}

async function look(ctx) {
  const { home, harnessDir, folder } = ctx;
  const profileDir = path.join(home, "profiles", PROFILE);
  const manifestFile = path.join(profileDir, "package.json");

  const processes = harnessDir ? await harnessRunning(ctx.processes, harnessDir) : { running: false, readable: true };
  const manifest = readManifest(manifestFile);
  const patch = manifest.exists ? readPatches([path.join(profileDir, "cordis.patch.yml"), path.join(home, "cordis.patch.yml")]) : { disabled: false, error: "" };

  let bundle = "not-installed";
  let linkedTo = null;
  let version = null;
  const dependencies = manifest.pkg && typeof manifest.pkg.dependencies === "object" && manifest.pkg.dependencies ? manifest.pkg.dependencies : {};
  const spec = Object.prototype.hasOwnProperty.call(dependencies, PACKAGE) ? dependencies[PACKAGE] : undefined;
  if (spec !== undefined) {
    linkedTo = linkTarget(spec, profileDir);
    // Installed some other way than as a link to a folder: not this folder.
    if (!linkedTo) bundle = "other-folder";
    else if (!isDirectory(linkedTo)) bundle = "folder-missing";
    else if (!samePath(linkedTo, folder)) bundle = "other-folder";
    else {
      const selected = manifest.pkg.dsh?.profile?.bundles;
      bundle = Array.isArray(selected) && selected.includes(PACKAGE) && !patch.disabled ? "installed" : "switched-off";
    }
    if (linkedTo && bundle !== "folder-missing") {
      const linked = readManifest(path.join(linkedTo, "package.json")).pkg;
      version = typeof linked?.version === "string" ? linked.version : null;
    }
  }

  const own = readManifest(path.join(folder, "package.json")).pkg;
  const unsafe = [folder, harnessDir ? commandIn(harnessDir) : ""].find((item) => UNSAFE.test(item));
  // The first that applies; what cannot be mended by closing Harness comes
  // before "close Harness".
  const unreadablePatch = patch.error;
  let reason = "";
  // An installed plugin needs nothing; only a patch that cannot be read is said.
  if (bundle === "installed") reason = unreadablePatch;
  else if (!harnessDir) reason = `${HARNESS} was not found on this computer. Install it and open it once, then try again.`;
  else if (!manifest.exists) reason = `${HARNESS} has not been opened on this computer yet. Open it once, quit it, then try again.`;
  else if (manifest.error) reason = `${manifestFile} cannot be read (${manifest.error}). Nothing was changed; repair or restore that file, then try again.`;
  else if (unreadablePatch) reason = unreadablePatch;
  else if (bundle === "switched-off") reason = SWITCHED_OFF;
  else if (own?.name !== PACKAGE) reason = `This DSHProxy's video plugin folder ${folder} is missing or incomplete. Restore the DSHProxy folder, then try again.`;
  else if (unsafe) reason = `The path ${unsafe} has a character (${UNSAFE_NAMES}) that cannot be passed to ${HARNESS}'s command safely. Move the folder to a path without it, or add the plugin by hand under Plugins > Add plugin in ${HARNESS}.`;
  else if (!processes.readable) reason = `DSHProxy could not check whether ${HARNESS} is running, so it counts as running. Quit ${HARNESS}, then try again.`;
  else if (processes.running) reason = `${HARNESS} is running. Quit it completely, then try again.`;

  return {
    harness: harnessDir ? "found" : "not-found",
    harnessRunning: processes.running,
    profile: PROFILE,
    profileExists: manifest.exists,
    bundle,
    folder,
    linkedTo,
    version,
    canInstall: !reason && ["not-installed", "other-folder", "folder-missing"].includes(bundle),
    reason
  };
}

// The contract's object. Reads only; never throws for what it finds.
async function state(deps = {}) {
  return look(context(deps));
}

// One or two sentences for a person at a terminal.
function describe(found) {
  // This reason already says what is so.
  if (found.reason === SWITCHED_OFF) return found.reason;
  const first = {
    installed: `The video plugin is installed in ${HARNESS}${found.version ? ` (version ${found.version})` : ""}.`,
    "switched-off": `The video plugin is installed in ${HARNESS} but switched off there.`,
    "other-folder": found.linkedTo ? `${HARNESS} has the video plugin from another folder (${found.linkedTo}).` : `${HARNESS} has the video plugin, but not from this DSHProxy folder.`,
    "folder-missing": `${HARNESS} points at a video plugin folder that is gone (${found.linkedTo}).`,
    "not-installed": `The video plugin is not installed in ${HARNESS}.`
  }[found.bundle];
  if (found.canInstall) return `${first} Run \`dshproxy dsh bundle install\` to ${found.bundle === "not-installed" ? "install it" : `point it at ${found.folder}`}.`;
  return found.reason ? `${first} ${found.reason}` : first;
}

// ------------------------------------------------------------ running the command

// Runs a `.cmd` file once and resolves { code, timedOut, output, error }.
// `error` is set, and nothing was started, when a part is not safe to pass
// or cmd.exe could not be started. After `timeoutMs` the child is ended with
// everything it started.
function runCommand({ command, args = [], env = process.env, cwd, timeoutMs = INSTALL_MS }) {
  return new Promise((resolve) => {
    const refused = [command, ...args].find((part) => typeof part !== "string" || !part || UNSAFE.test(part) || part.endsWith("\\"));
    if (refused !== undefined) return resolve({ code: null, timedOut: false, output: "", error: `not started: ${JSON.stringify(refused)} cannot be passed to cmd.exe safely` });
    const quoted = (part) => (/^[A-Za-z0-9_.-]+$/.test(part) ? part : `"${part}"`);
    // /s: the outer quotes are dropped and the rest is taken as written.
    // /v:off: `!` stays a plain character whatever the registry says.
    // /d: no AutoRun commands. 2>&1: one stream, in the order it was written.
    const line = `""${command}" ${args.map(quoted).join(" ")} 2>&1"`;
    let child;
    try {
      child = spawn(system32("cmd.exe"), ["/d", "/v:off", "/s", "/c", line], { cwd, env, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      return resolve({ code: null, timedOut: false, output: "", error: `not started: ${firstLine(error.message)}` });
    }
    let output = "";
    let timedOut = false;
    let settled = false;
    let timer = null;
    let grace = null;
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ code: timedOut ? null : code, timedOut, output, error });
    };
    child.on("error", (error) => finish(null, `not started: ${firstLine(error.message)}`));
    child.on("close", (code) => finish(code));
    // A child that could not be started has no output to read.
    if (!child.pid || !child.stdout) return undefined;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-KEPT_OUTPUT);
    });
    timer = setTimeout(() => {
      timedOut = true;
      // Ending cmd.exe alone would leave what it started.
      execFile(system32("taskkill.exe"), ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, timeout: 15000 }, () => {
        // Something that outlived the tree may still hold the output open.
        grace = setTimeout(() => {
          child.stdout.destroy();
          child.unref();
          finish(null);
        }, STOPPED_GRACE_MS);
      });
    }, timeoutMs);
    return undefined;
  });
}

// What the command's environment is: no DSH_* of this process (they belong to
// the Harness session DSHProxy may have been started from), the Harness home
// in use, and no ELECTRON_RUN_AS_NODE (the command sets it itself).
function childEnv(env, home) {
  const result = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^DSH_/i.test(name) || name.toUpperCase() === "ELECTRON_RUN_AS_NODE") continue;
    result[name] = value;
  }
  result.DSH_HOME = home;
  return result;
}

// The last line of the command's output that says something.
function lastLine(output) {
  const lines = String(output || "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split(/[\r\n]+/).map((line) => line.replace(/[\u0000-\u001f]/g, " ").trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : "";
}

// DSHProxy's own record of the one run. Returns its path, or null when it
// could not be written.
function writeLog(file, lines) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join("\r\n")}\r\n`);
    return file;
  } catch {
    return null;
  }
}

// Looks; when the plugin is installed says so; when it cannot be installed
// gives the reason and runs nothing; otherwise runs DeepSeek Harness's command
// once, never again, and looks once more. `ok` only when the profile then
// reads `installed`.
async function install(deps = {}) {
  const ctx = context(deps);
  const before = await look(ctx);
  if (before.bundle === "installed") return { ok: true, bundle: before.bundle, message: `The video plugin is already installed in ${HARNESS}; nothing was changed.${before.reason ? ` ${before.reason}` : ""}`, log: null };
  if (!before.canInstall) return { ok: false, bundle: before.bundle, message: before.reason, log: null };

  const command = commandIn(ctx.harnessDir);
  const args = ["plugin", "--profile", PROFILE, "add", ctx.folder];
  const startedAt = new Date();
  let result;
  try {
    result = await ctx.run({ command, args, env: childEnv(ctx.env, ctx.home), cwd: path.dirname(command), timeoutMs: ctx.timeoutMs });
  } catch (error) {
    result = { code: null, timedOut: false, output: "", error: `not started: ${firstLine(error?.message)}` };
  }
  const seconds = Math.round(ctx.timeoutMs / 1000);
  const outcome = result.error ? result.error : result.timedOut ? `stopped after ${seconds} seconds without finishing` : `exit code ${result.code}`;
  const log = writeLog(ctx.logFile, [
    `DSHProxy ran ${HARNESS}'s command once.`,
    `Started: ${startedAt.toISOString()}`,
    `Command: "${command}" plugin --profile ${PROFILE} add "${ctx.folder}"`,
    `DSH_HOME: ${ctx.home}`,
    `Result: ${outcome}`,
    "Output:",
    String(result.output || "").trimEnd()
  ]);

  const after = await look(ctx);
  const ok = after.bundle === "installed";
  const last = lastLine(result.output);
  const said = last ? ` Its last line was "${last}".` : "";
  const byHand = `To add it by hand, enter ${ctx.folder} under Plugins > Add plugin in ${HARNESS}.`;
  let message;
  if (result.error) message = `${HARNESS}'s command could not be started (${result.error.replace(/^not started: /, "")}). ${ok ? "The profile shows the video plugin as installed." : byHand}`;
  else if (result.timedOut) message = ok ? `${HARNESS}'s command did not finish within ${seconds} seconds and was stopped, but the profile shows the video plugin as installed. Start ${HARNESS} and check under Plugins.` : `${HARNESS}'s command did not finish within ${seconds} seconds and was stopped; the video plugin is not installed.${said} ${byHand}`;
  else if (ok) message = result.code === 0 ? `The video plugin is installed in ${HARNESS}. Start ${HARNESS} to use the video tools.` : `${HARNESS}'s command ended with exit code ${result.code}, but the profile shows the video plugin as installed.${said} Start ${HARNESS} and check under Plugins.`;
  else if (result.code !== 0) message = `${HARNESS}'s command failed (exit code ${result.code}).${said} ${byHand}`;
  else if (after.bundle === "switched-off") message = `${HARNESS}'s command finished and the video plugin now comes from this DSHProxy folder, but it is switched off in ${HARNESS}. Switch it on under Plugins in ${HARNESS}.`;
  else message = `${HARNESS}'s command finished, but the profile does not show the video plugin as installed.${said} ${byHand}`;
  return { ok, bundle: after.bundle, message, log };
}

module.exports = { PACKAGE, PROFILE, state, install, describe, locateHarness, runCommand };
