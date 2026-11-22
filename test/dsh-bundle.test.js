const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const bundle = require("../src/dsh/bundle");

const CLI = path.join(__dirname, "..", "bin", "dshproxy.js");
const NAME = "@local/dshproxy-video";
const BASE_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
const CONTRACT_KEYS = ["harness", "harnessRunning", "profile", "profileExists", "bundle", "folder", "linkedTo", "version", "canInstall", "canInstallAfterQuit", "reason"];

// What stands in for DeepSeek Harness's `dsh.cmd`: the same shape as the real
// one (a batch file that hands its arguments to a program), with a Node script
// in place of Harness. It records each call and, in mode `ok`, changes the
// profile the way the real command was seen to.
const STAND_IN_SCRIPT = `
const fs = require("fs");
const path = require("path");
const mode = fs.readFileSync(path.join(__dirname, "mode.txt"), "utf8").trim();
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ argv, env: process.env, pid: process.pid }) + "\\n");
function install() {
  const folder = argv[4];
  const dir = path.join(process.env.DSH_HOME, "profiles", argv[2]);
  const file = path.join(dir, "package.json");
  if (!fs.existsSync(file)) {
    console.error("Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.");
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  const name = JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8")).name;
  const had = Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, name);
  pkg.dependencies = { ...pkg.dependencies, [name]: "link:" + folder.replace(/\\\\/g, "/") };
  // As the real command: a dependency that was there before is not selected again.
  if (!had && !pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\\n");
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\\n");
  fs.mkdirSync(path.join(dir, ".plugin-manager", "logs", "operation-000001"), { recursive: true });
  console.log("Progress: resolved 1, reused 0, downloaded 0, added 0, done");
  console.log("+ " + name + " 0.1.0 <- " + folder);
}
if (mode === "ok") install();
else if (mode === "fail") {
  console.log("an earlier line that must not be shown");
  console.error("dsh: plugin command failed; diagnostics: C:\\\\somewhere\\\\pnpm.log");
  console.log("");
  process.exitCode = 1;
} else if (mode === "noop") console.log("Already up to date");
else if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "ok-then-hang") {
  install();
  setInterval(() => {}, 1000);
}
`;

const commandDir = (harness) => path.join(harness, "resources", "runtime", "cli", "bin");

function writeStandIn(harness, mode = "ok") {
  const dir = commandDir(harness);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "standin.js"), STAND_IN_SCRIPT);
  fs.writeFileSync(path.join(dir, "mode.txt"), mode);
  // The first line records the arguments exactly as cmd.exe handed them over.
  fs.writeFileSync(path.join(dir, "dsh.cmd"), ["@echo off", "setlocal DisableDelayedExpansion", ">>\"%~dp0raw.log\" echo(%*", `"${process.execPath}" "%~dp0standin.js" %*`, "exit /b %errorlevel%", ""].join("\r\n"));
}

function calls(harness) {
  const file = path.join(commandDir(harness), "calls.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

function rawCalls(harness) {
  const file = path.join(commandDir(harness), "raw.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : [];
}

// A throwaway Harness home, Harness program folder and DSHProxy root. The
// root's name has a space, as a real folder may.
function sandbox(t, { rootName = "DSH Proxy root", standIn = "ok" } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-bundle-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const box = { base, home: path.join(base, "home"), harness: path.join(base, "harness"), root: path.join(base, rootName), logFile: path.join(base, "data", "dsh-bundle-install.log") };
  box.folder = path.join(box.root, "integrations", "dsh-video");
  fs.mkdirSync(box.home, { recursive: true });
  fs.mkdirSync(box.folder, { recursive: true });
  fs.writeFileSync(path.join(box.folder, "package.json"), JSON.stringify({ name: NAME, version: "0.1.0", private: true, dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
  if (standIn) writeStandIn(box.harness, standIn);
  else fs.mkdirSync(box.harness, { recursive: true });
  return box;
}

const profileDir = (box) => path.join(box.home, "profiles", "desktop");
const link = (folder) => `link:${folder.replace(/\\/g, "/")}`;

// `patch` is the profile's own patch; `homePatch` is the one in the Harness
// home, which applies to every profile after the profile's own.
function writeProfile(box, { dependencies = {}, bundles = BASE_BUNDLES, patch = null, homePatch = null } = {}) {
  fs.mkdirSync(profileDir(box), { recursive: true });
  fs.writeFileSync(path.join(profileDir(box), "package.json"), `${JSON.stringify({ name: "dsh-profile-desktop", private: true, dependencies, dsh: { profile: { bundles } } }, null, 2)}\n`);
  if (patch !== null) fs.writeFileSync(path.join(profileDir(box), "cordis.patch.yml"), patch);
  if (homePatch !== null) fs.writeFileSync(homePatchFile(box), homePatch);
}

const homePatchFile = (box) => path.join(box.home, "cordis.patch.yml");
const profilePatchFile = (box) => path.join(profileDir(box), "cordis.patch.yml");
const DISABLED = "- id: dshproxy-video\n  disabled: true\n";
const ENABLED = "- id: dshproxy-video\n  disabled: false\n";

const readProfile = (box) => JSON.parse(fs.readFileSync(path.join(profileDir(box), "package.json"), "utf8"));

// The injected outside world: no Harness process, unless a test says otherwise.
function deps(box, extra = {}) {
  return { home: box.home, harnessDir: box.harness, root: box.root, processes: async () => [], logFile: box.logFile, ...extra };
}

// A run function that only counts: for the cases where nothing may be run.
function spy() {
  const seen = [];
  const run = async (request) => {
    seen.push(request);
    return { code: 0, timedOut: false, output: "", error: null };
  };
  return { seen, run };
}

// Every file and folder under `dir`, with its content and time of change.
function snapshot(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const stat = fs.statSync(full);
      if (entry.isDirectory()) {
        found.push([path.relative(dir, full), "dir"]);
        walk(full);
      } else found.push([path.relative(dir, full), stat.size, stat.mtimeMs, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")]);
    }
  };
  walk(dir);
  return found;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function untilGone(pid, ms = 10000) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100));
  return !alive(pid);
}

// ---------------------------------------------------------------- state

test("installed: a link to this folder, selected, and not switched off in the patch", async (t) => {
  const box = sandbox(t);
  // The profile writes the path with forward slashes and in another case; an
  // entry for the plugin that is not disabled changes nothing.
  writeProfile(box, {
    dependencies: { [NAME]: link(box.folder).toUpperCase().replace(/^LINK:/, "link:") },
    bundles: [...BASE_BUNDLES, NAME],
    patch: "- id: ui-chat\n  disabled: true\n- id: dshproxy-video\n  config: {}\n"
  });
  const found = await bundle.state(deps(box));
  assert.deepEqual(Object.keys(found), CONTRACT_KEYS);
  assert.deepEqual(found, { harness: "found", harnessRunning: false, profile: "desktop", profileExists: true, bundle: "installed", folder: box.folder, linkedTo: found.linkedTo, version: "0.1.0", canInstall: false, canInstallAfterQuit: false, reason: "" });
  assert.equal(found.linkedTo.toLowerCase(), box.folder.toLowerCase());
});

test("switched-off: linked to this folder but not among the profile's bundles", async (t) => {
  const box = sandbox(t);
  writeProfile(box, { dependencies: { [NAME]: link(box.folder) } });
  const found = await bundle.state(deps(box));
  assert.equal(found.bundle, "switched-off");
  assert.equal(found.linkedTo, box.folder);
  assert.equal(found.canInstall, false);
  assert.match(found.reason, /switched off in DeepSeek Harness/);
});

test("switched-off: selected, but disabled in the profile's patch", async (t) => {
  const box = sandbox(t);
  writeProfile(box, { dependencies: { [NAME]: link(box.folder) }, bundles: [...BASE_BUNDLES, NAME], patch: "# the person's own layer\n- id: dshproxy-video\n  disabled: true\n" });
  const found = await bundle.state(deps(box));
  assert.equal(found.bundle, "switched-off");
  assert.equal(found.canInstall, false);
  assert.match(found.reason, /switched off in DeepSeek Harness/);
});

test("switched-off: selected, but disabled in the home-level patch, and nothing is installed over it", async (t) => {
  const box = sandbox(t);
  writeProfile(box, { dependencies: { [NAME]: link(box.folder) }, bundles: [...BASE_BUNDLES, NAME], homePatch: `# applies to every profile\n- id: ui-chat\n  config: {}\n${DISABLED}` });
  const found = await bundle.state(deps(box));
  assert.equal(found.bundle, "switched-off");
  assert.equal(found.canInstall, false);
  assert.match(found.reason, /switched off in DeepSeek Harness\. Switch it on under Plugins in DeepSeek Harness/);
  const result = await bundle.install(deps(box));
  assert.equal(result.ok, false);
  assert.equal(result.bundle, "switched-off");
  assert.deepEqual(calls(box.harness), []);
});

test("the home-level patch is the later layer: what it says about the plugin wins over the profile's patch", async (t) => {
  const box = sandbox(t);
  const linked = { dependencies: { [NAME]: link(box.folder) }, bundles: [...BASE_BUNDLES, NAME] };
  const bundleWith = async (patch, homePatch) => {
    fs.rmSync(profilePatchFile(box), { force: true });
    fs.rmSync(homePatchFile(box), { force: true });
    writeProfile(box, { ...linked, patch, homePatch });
    return (await bundle.state(deps(box))).bundle;
  };
  assert.equal(await bundleWith(DISABLED, ENABLED), "installed");
  assert.equal(await bundleWith(ENABLED, DISABLED), "switched-off");
  assert.equal(await bundleWith(null, ENABLED), "installed");
  // A home-level patch that does not say whether the plugin is disabled leaves the profile's word.
  assert.equal(await bundleWith(DISABLED, "- id: ui-chat\n  disabled: true\n- id: dshproxy-video\n  config: {}\n"), "switched-off");
  assert.equal(await bundleWith(DISABLED, ""), "switched-off");
  assert.equal(await bundleWith(ENABLED, "- id: ui-chat\n  disabled: true\n"), "installed");
  // No home-level patch at all is the usual case.
  assert.equal(await bundleWith(DISABLED, null), "switched-off");
  assert.equal(await bundleWith(null, null), "installed");
});

test("a home-level patch that cannot be parsed is reported with its own file name, not thrown", async (t) => {
  const box = sandbox(t);
  writeProfile(box, { homePatch: "- id: [broken\n" });
  const found = await bundle.state(deps(box));
  assert.equal(found.bundle, "not-installed");
  assert.equal(found.canInstall, false);
  assert.ok(found.reason.startsWith(`${homePatchFile(box)} cannot be read`), found.reason);
  assert.ok(!found.reason.includes(profilePatchFile(box)), found.reason);
  assert.doesNotMatch(found.reason, /\n|    at /);
  const counted = spy();
  const refused = await bundle.install(deps(box, { run: counted.run }));
  assert.equal(refused.ok, false);
  assert.equal(counted.seen.length, 0);

  // Linked and selected: what package.json says, with the doubt said.
  writeProfile(box, { dependencies: { [NAME]: link(box.folder) }, bundles: [...BASE_BUNDLES, NAME] });
  const linked = await bundle.state(deps(box));
  assert.equal(linked.bundle, "installed");
  assert.equal(linked.canInstall, false);
  assert.ok(linked.reason.startsWith(`${homePatchFile(box)} cannot be read`), linked.reason);
  assert.match(linked.reason, /not known whether the video plugin is switched on/);

  // When both cannot be parsed, the profile's own is named first.
  fs.writeFileSync(profilePatchFile(box), "- id: [broken too\n");
  assert.ok((await bundle.state(deps(box))).reason.startsWith(`${profilePatchFile(box)} cannot be read`));
});

test("other-folder: linked to another folder that exists", async (t) => {
  const box = sandbox(t);
  const other = path.join(box.base, "older DSHProxy", "integrations", "dsh-video");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "package.json"), JSON.stringify({ name: NAME, version: "0.0.9" }));
  writeProfile(box, { dependencies: { [NAME]: link(other) }, bundles: [...BASE_BUNDLES, NAME] });
  const found = await bundle.state(deps(box));
  assert.equal(found.bundle, "other-folder");
  assert.equal(found.linkedTo, other);
  assert.equal(found.folder, box.folder);
  assert.equal(found.version, "0.0.9");
  assert.equal(found.canInstall, true);
  assert.equal(found.reason, "");
});

test("folder-missing: linked to a folder that is gone", async (t) => {
  const box = sandbox(t);
  const gone = path.join(box.base, "moved away", "integrations", "dsh-video");
  writeProfile(box, { dependencies: { [NAME]: link(gone) }, bundles: [...BASE_BUNDLES, NAME] });
  const found = await bundle.state(deps(box));
  assert.equal(found.bundle, "folder-missing");
  assert.equal(found.linkedTo, gone);
  assert.equal(found.version, null);
  assert.equal(found.canInstall, true);
});

test("not-installed: the profile does not name the plugin", async (t) => {
  const box = sandbox(t);
  writeProfile(box);
  const found = await bundle.state(deps(box));
  assert.deepEqual(found, { harness: "found", harnessRunning: false, profile: "desktop", profileExists: true, bundle: "not-installed", folder: box.folder, linkedTo: null, version: null, canInstall: true, canInstallAfterQuit: false, reason: "" });
});

test("a link written relative to the profile folder is resolved from there", async (t) => {
  const box = sandbox(t);
  writeProfile(box, { dependencies: { [NAME]: `link:${path.relative(profileDir(box), box.folder)}` }, bundles: [...BASE_BUNDLES, NAME] });
  const found = await bundle.state(deps(box));
  assert.equal(found.bundle, "installed");
  assert.equal(found.linkedTo, box.folder);
});

test("a Harness home that was never opened has no profile and nothing can be installed", async (t) => {
  const box = sandbox(t);
  const found = await bundle.state(deps(box));
  assert.equal(found.profileExists, false);
  assert.equal(found.bundle, "not-installed");
  assert.equal(found.canInstall, false);
  assert.match(found.reason, /has not been opened/);
  assert.match(found.reason, /Open it once/);
});

test("Harness is not found when its command is not in the program folder", async (t) => {
  const box = sandbox(t, { standIn: null });
  writeProfile(box);
  let asked = 0;
  const found = await bundle.state(deps(box, { processes: async () => { asked += 1; return []; } }));
  assert.equal(found.harness, "not-found");
  assert.equal(found.harnessRunning, false);
  assert.equal(found.canInstall, false);
  assert.match(found.reason, /DeepSeek Harness was not found/);
  assert.equal(asked, 0, "there is no folder to match processes against");
});

test("Harness is running when a DeepSeek Harness.exe from its folder exists", async (t) => {
  const box = sandbox(t);
  writeProfile(box);
  const exe = path.join(box.harness, "DeepSeek Harness.exe");
  const running = await bundle.state(deps(box, { processes: async () => [{ name: "deepseek harness.EXE", path: exe.toUpperCase().replace(/\\/g, "/") }] }));
  assert.equal(running.harnessRunning, true);
  assert.equal(running.canInstall, false);
  assert.match(running.reason, /DeepSeek Harness is running\. Quit it/);
  // Quitting Harness is all that is needed, and the answer says so.
  assert.equal(running.canInstallAfterQuit, true);

  // An installed plugin needs no quit; nor does one that was switched off.
  const open = { processes: async () => [{ name: "DeepSeek Harness.exe", path: exe }] };
  writeProfile(box, { dependencies: { [NAME]: link(box.folder) }, bundles: [...BASE_BUNDLES, NAME] });
  const installedOpen = await bundle.state(deps(box, open));
  assert.equal(installedOpen.bundle, "installed");
  assert.equal(installedOpen.canInstallAfterQuit, false);

  // Something else is in the way as well: quitting Harness would not be enough.
  writeProfile(box, { dependencies: {}, bundles: BASE_BUNDLES, patch: "- id: [unclosed\n" });
  const alsoBroken = await bundle.state(deps(box, open));
  assert.equal(alsoBroken.harnessRunning, true);
  assert.equal(alsoBroken.canInstall, false);
  assert.equal(alsoBroken.canInstallAfterQuit, false);
  fs.rmSync(profilePatchFile(box));
  writeProfile(box);

  // The same name from another folder, and another program from this folder, are not it.
  const elsewhere = await bundle.state(deps(box, { processes: async () => [{ name: "DeepSeek Harness.exe", path: path.join(box.base, "harness-other", "DeepSeek Harness.exe") }, { name: "node.exe", path: path.join(box.harness, "node.exe") }] }));
  assert.equal(elsewhere.harnessRunning, false);
  assert.equal(elsewhere.canInstall, true);

  // A Harness process whose program path Windows does not give counts as running.
  const hidden = await bundle.state(deps(box, { processes: async () => [{ name: "DeepSeek Harness.exe", path: null }] }));
  assert.equal(hidden.harnessRunning, true);
});

test("a process list that cannot be read counts as Harness running", async (t) => {
  const box = sandbox(t);
  writeProfile(box);
  for (const processes of [async () => { throw new Error("Access denied\n    at somewhere (file.js:1:1)"); }, async () => null]) {
    const found = await bundle.state(deps(box, { processes }));
    assert.equal(found.harnessRunning, true);
    assert.equal(found.canInstall, false);
    assert.match(found.reason, /could not check whether DeepSeek Harness is running/);
    assert.doesNotMatch(found.reason, /file\.js|\n/);
  }
});

test("a profile package.json that cannot be parsed is reported, not thrown", async (t) => {
  const box = sandbox(t);
  writeProfile(box);
  fs.writeFileSync(path.join(profileDir(box), "package.json"), "{ \"name\": \"dsh-profile-desktop\", ");
  const found = await bundle.state(deps(box));
  assert.equal(found.profileExists, true);
  assert.equal(found.bundle, "not-installed");
  assert.equal(found.canInstall, false);
  assert.match(found.reason, /package\.json cannot be read/);
  assert.doesNotMatch(found.reason, /\n|    at /);
});

test("a profile patch that cannot be parsed is reported, not thrown", async (t) => {
  const box = sandbox(t);
  writeProfile(box, { patch: "- id: ui-chat\n  config: [unclosed\n" });
  const found = await bundle.state(deps(box));
  assert.equal(found.bundle, "not-installed");
  assert.equal(found.canInstall, false);
  assert.match(found.reason, /cordis\.patch\.yml cannot be read/);
  assert.doesNotMatch(found.reason, /\n|    at /);
});

test("a linked and selected plugin with an unreadable patch reads installed, with the doubt said, and nothing is run", async (t) => {
  const box = sandbox(t);
  writeProfile(box, { dependencies: { [NAME]: link(box.folder) }, bundles: [...BASE_BUNDLES, NAME], patch: "- id: [broken\n" });
  const found = await bundle.state(deps(box));
  assert.equal(found.bundle, "installed");
  assert.equal(found.canInstall, false);
  assert.match(found.reason, /cordis\.patch\.yml cannot be read .* not known whether the video plugin is switched on/);
  const result = await bundle.install(deps(box));
  assert.equal(result.ok, true);
  assert.ok(result.message.includes(found.reason));
  assert.deepEqual(calls(box.harness), []);
});

test("looking writes nothing, whatever the profile holds", async (t) => {
  const box = sandbox(t);
  const gone = path.join(box.base, "gone");
  const profiles = [
    null,
    {},
    { dependencies: { [NAME]: link(box.folder) }, bundles: [...BASE_BUNDLES, NAME], patch: "- id: dshproxy-video\n  disabled: true\n" },
    { dependencies: { [NAME]: link(gone) } },
    { patch: "- id: [broken\n" },
    { dependencies: { [NAME]: link(box.folder) }, bundles: [...BASE_BUNDLES, NAME], patch: ENABLED, homePatch: DISABLED },
    { dependencies: { [NAME]: link(box.folder) }, bundles: [...BASE_BUNDLES, NAME], patch: DISABLED, homePatch: ENABLED },
    { homePatch: "- id: [broken\n" }
  ];
  for (const profile of profiles) {
    if (profile) writeProfile(box, profile);
    const before = snapshot(box.base);
    await bundle.state(deps(box));
    await bundle.state(deps(box, { processes: async () => { throw new Error("no"); } }));
    assert.deepEqual(snapshot(box.base), before);
  }
});

test("a folder whose name cmd.exe would act on is refused and never reaches a shell", async (t) => {
  const box = sandbox(t, { rootName: "a & echo INJECTED" });
  writeProfile(box);
  assert.ok(fs.existsSync(path.join(box.root, "integrations", "dsh-video", "package.json")), "the folder really has that name");

  const found = await bundle.state(deps(box));
  assert.equal(found.bundle, "not-installed");
  assert.equal(found.canInstall, false);
  assert.match(found.reason, /cannot be passed to DeepSeek Harness's command safely/);

  // With the real way of running the command: the stand-in is never started.
  const result = await bundle.install(deps(box));
  assert.equal(result.ok, false);
  assert.equal(result.message, found.reason);
  assert.equal(result.log, null);
  assert.deepEqual(calls(box.harness), []);
  assert.deepEqual(rawCalls(box.harness), []);
  // And nothing is asked to run at all.
  const counted = spy();
  await bundle.install(deps(box, { run: counted.run }));
  assert.equal(counted.seen.length, 0);
  assert.deepEqual(readProfile(box).dependencies, {});
});

test("the way the command is run refuses every character cmd.exe acts on", async (t) => {
  const box = sandbox(t);
  const command = path.join(commandDir(box.harness), "dsh.cmd");
  const cwd = path.join(box.base, "cwd");
  fs.mkdirSync(cwd);
  for (const bad of ["a & echo INJECTED", "a & mkdir INJECTED", "%COMSPEC%", "a^b", "a|b", "a<b", "a>b", "a!b", "a\"b", "a\nb", "a\rb", "C:\\ends with a backslash\\"]) {
    const result = await bundle.runCommand({ command, args: ["plugin", "--profile", "desktop", "add", bad], env: process.env, cwd, timeoutMs: 20000 });
    assert.equal(result.code, null, JSON.stringify(bad));
    assert.match(result.error, /not started/, JSON.stringify(bad));
  }
  // A command path with such a character is refused the same way.
  const viaCommand = await bundle.runCommand({ command: path.join(box.base, "a & mkdir INJECTED", "dsh.cmd"), args: ["plugin"], env: process.env, cwd, timeoutMs: 20000 });
  assert.match(viaCommand.error, /not started/);
  assert.deepEqual(calls(box.harness), []);
  assert.deepEqual(rawCalls(box.harness), []);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

// ---------------------------------------------------------------- where Harness is

test("Harness is looked for in DSHPROXY_HARNESS_DIR, then the usual folder, then the dsh: link's program", (t) => {
  const box = sandbox(t);
  const local = path.join(box.base, "local");
  const usual = path.join(local, "Programs", "DeepSeek Harness");
  const registered = path.join(box.base, "registered");
  writeStandIn(usual);
  writeStandIn(registered);
  const registry = () => `"${path.join(registered, "DeepSeek Harness.exe")}" "%1"`;
  let asked = 0;
  const counting = () => { asked += 1; return registry(); };

  // The variable wins, and when it is set nothing else is tried.
  assert.equal(bundle.locateHarness({ env: { DSHPROXY_HARNESS_DIR: box.harness, LOCALAPPDATA: local }, registry: counting }), box.harness);
  assert.equal(bundle.locateHarness({ env: { DSHPROXY_HARNESS_DIR: path.join(box.base, "nothing here"), LOCALAPPDATA: local }, registry: counting }), null);
  assert.equal(bundle.locateHarness({ env: { LOCALAPPDATA: local }, registry: counting }), usual);
  assert.equal(asked, 0);
  // Not in the usual folder: the program registered for dsh: links.
  assert.equal(bundle.locateHarness({ env: { LOCALAPPDATA: path.join(box.base, "empty") }, registry }), registered);
  assert.equal(bundle.locateHarness({ env: {}, registry: () => null }), null);
  assert.equal(bundle.locateHarness({ env: {}, registry: () => { throw new Error("no such key"); } }), null);
  assert.equal(bundle.locateHarness({ env: {}, registry: () => `"${path.join(box.base, "no command here", "DeepSeek Harness.exe")}" "%1"` }), null);
});

// ---------------------------------------------------------------- install

test("install runs Harness's command once, with exactly its arguments and a clean environment", async (t) => {
  const box = sandbox(t);
  writeProfile(box);
  const env = { ...process.env, DSH_HOME: "C:\\somebody\\elses\\.dsh", DSH_WEB_URL: "http://127.0.0.1:1", DSH_INSTALL_DIR: "C:\\x", dsh_lowercase: "1", ELECTRON_RUN_AS_NODE: "1", DSHPROXY_KEPT: "yes" };
  const result = await bundle.install(deps(box, { env }));

  assert.deepEqual(Object.keys(result), ["ok", "bundle", "message", "log"]);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.bundle, "installed");
  assert.match(result.message, /The video plugin is installed in DeepSeek Harness/);

  const seen = calls(box.harness);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].argv, ["plugin", "--profile", "desktop", "add", box.folder]);
  assert.deepEqual(rawCalls(box.harness), [`plugin --profile desktop add "${box.folder}"`]);

  const childEnv = seen[0].env;
  const dshNames = Object.keys(childEnv).filter((name) => /^DSH_/i.test(name));
  assert.deepEqual(dshNames, ["DSH_HOME"]);
  assert.equal(childEnv.DSH_HOME, box.home);
  assert.equal(Object.keys(childEnv).some((name) => name.toUpperCase() === "ELECTRON_RUN_AS_NODE"), false);
  assert.equal(childEnv.DSHPROXY_KEPT, "yes");

  // The profile is as the command left it, and reads as installed.
  assert.equal(readProfile(box).dependencies[NAME], link(box.folder));
  assert.deepEqual(readProfile(box).dsh.profile.bundles, [...BASE_BUNDLES, NAME]);
  assert.equal((await bundle.state(deps(box))).bundle, "installed");

  // The log holds the whole output of the one run.
  assert.equal(result.log, box.logFile);
  const log = fs.readFileSync(result.log, "utf8");
  assert.match(log, /Progress: resolved 1/);
  assert.ok(log.includes(`plugin --profile desktop add "${box.folder}"`));
});

test("install when the plugin is already installed runs nothing", async (t) => {
  const box = sandbox(t);
  writeProfile(box, { dependencies: { [NAME]: link(box.folder) }, bundles: [...BASE_BUNDLES, NAME] });
  const before = snapshot(box.base);
  const result = await bundle.install(deps(box));
  assert.deepEqual(result, { ok: true, bundle: "installed", message: result.message, log: null });
  assert.match(result.message, /already installed/);
  assert.deepEqual(calls(box.harness), []);
  assert.deepEqual(snapshot(box.base), before);
});

test("install runs nothing when it cannot install, and gives the reason", async (t) => {
  const cases = [
    { name: "Harness is running", profile: {}, extra: (box) => ({ processes: async () => [{ name: "DeepSeek Harness.exe", path: path.join(box.harness, "DeepSeek Harness.exe") }] }), reason: /DeepSeek Harness is running/ },
    { name: "the process list cannot be read", profile: {}, extra: () => ({ processes: async () => { throw new Error("denied"); } }), reason: /could not check whether DeepSeek Harness is running/ },
    { name: "Harness was never opened", profile: null, extra: () => ({}), reason: /has not been opened/ },
    { name: "Harness is not found", profile: {}, standIn: null, extra: () => ({}), reason: /was not found/ },
    { name: "the plugin is switched off", profile: (box) => ({ dependencies: { [NAME]: link(box.folder) } }), extra: () => ({}), reason: /switched off/, bundle: "switched-off" },
    { name: "the profile cannot be parsed", profile: {}, broken: true, extra: () => ({}), reason: /package\.json cannot be read/ }
  ];
  for (const item of cases) {
    const box = sandbox(t, item.standIn === null ? { standIn: null } : {});
    const profile = typeof item.profile === "function" ? item.profile(box) : item.profile;
    if (profile) writeProfile(box, profile);
    if (item.broken) fs.writeFileSync(path.join(profileDir(box), "package.json"), "not json");
    const before = snapshot(box.base);

    // With the real way of running: the stand-in records no call.
    const real = await bundle.install(deps(box, item.extra(box)));
    assert.equal(real.ok, false, item.name);
    assert.equal(real.bundle, item.bundle || "not-installed", item.name);
    assert.match(real.message, item.reason, item.name);
    assert.equal(real.log, null, item.name);
    assert.deepEqual(calls(box.harness), [], item.name);
    // With a counting stand-in for running: it is never asked.
    const counted = spy();
    await bundle.install(deps(box, { ...item.extra(box), run: counted.run }));
    assert.equal(counted.seen.length, 0, item.name);
    assert.deepEqual(snapshot(box.base), before, item.name);
  }
});

test("a command that exits 1 ends not ok, with its last line and the manual way, after one run", async (t) => {
  const box = sandbox(t, { standIn: "fail" });
  writeProfile(box);
  const result = await bundle.install(deps(box));
  assert.equal(result.ok, false);
  assert.equal(result.bundle, "not-installed");
  assert.match(result.message, /failed \(exit code 1\)/);
  assert.ok(result.message.includes("dsh: plugin command failed; diagnostics: C:\\somewhere\\pnpm.log"), result.message);
  assert.doesNotMatch(result.message, /an earlier line/);
  assert.ok(result.message.includes(box.folder) && /Plugins > Add plugin/.test(result.message), result.message);
  assert.equal(calls(box.harness).length, 1);
  assert.match(fs.readFileSync(result.log, "utf8"), /an earlier line that must not be shown/);
  assert.deepEqual(readProfile(box).dependencies, {});
});

test("a command that exits 0 without changing the profile ends not ok, after one run", async (t) => {
  const box = sandbox(t, { standIn: "noop" });
  writeProfile(box);
  const result = await bundle.install(deps(box));
  assert.equal(result.ok, false);
  assert.equal(result.bundle, "not-installed");
  assert.match(result.message, /finished, but the profile does not show the video plugin as installed/);
  assert.ok(result.message.includes("Already up to date"), result.message);
  assert.match(result.message, /Plugins > Add plugin/);
  assert.equal(calls(box.harness).length, 1);
});

test("a plugin relinked from another folder that was not selected ends not ok and says it is switched off", async (t) => {
  const box = sandbox(t);
  const other = path.join(box.base, "older", "integrations", "dsh-video");
  fs.mkdirSync(other, { recursive: true });
  writeProfile(box, { dependencies: { [NAME]: link(other) } });
  const result = await bundle.install(deps(box));
  assert.equal(calls(box.harness).length, 1);
  assert.equal(readProfile(box).dependencies[NAME], link(box.folder));
  assert.equal(result.ok, false);
  assert.equal(result.bundle, "switched-off");
  assert.match(result.message, /switched off in DeepSeek Harness/);
});

test("a command that hangs is ended with its children after the time limit, after one run", async (t) => {
  const box = sandbox(t, { standIn: "hang" });
  writeProfile(box);
  const started = Date.now();
  const result = await bundle.install(deps(box, { timeoutMs: 4000 }));
  assert.ok(Date.now() - started < 30000);
  assert.equal(result.ok, false);
  assert.equal(result.bundle, "not-installed");
  assert.match(result.message, /did not finish within 4 seconds/);
  assert.match(result.message, /Plugins > Add plugin/);
  const seen = calls(box.harness);
  assert.equal(seen.length, 1);
  // The program the batch file started is gone too, not only cmd.exe.
  assert.equal(await untilGone(seen[0].pid), true, "the child of cmd.exe is still running");
  assert.match(fs.readFileSync(result.log, "utf8"), /stopped after/);
});

test("after a time limit the result is what the profile says", async (t) => {
  const box = sandbox(t, { standIn: "ok-then-hang" });
  writeProfile(box);
  const result = await bundle.install(deps(box, { timeoutMs: 4000 }));
  assert.equal(result.ok, true);
  assert.equal(result.bundle, "installed");
  assert.match(result.message, /did not finish within 4 seconds/);
  const seen = calls(box.harness);
  assert.equal(seen.length, 1);
  assert.equal(await untilGone(seen[0].pid), true);
});

test("a command that cannot be started ends not ok without a second try", async (t) => {
  const box = sandbox(t);
  writeProfile(box);
  let asked = 0;
  const run = async () => {
    asked += 1;
    throw new Error("spawn EPERM\n    at ChildProcess.spawn (node:internal/child_process:420:11)");
  };
  const result = await bundle.install(deps(box, { run }));
  assert.equal(asked, 1);
  assert.equal(result.ok, false);
  assert.match(result.message, /could not be started \(spawn EPERM\)/);
  assert.doesNotMatch(result.message, /child_process|\n/);
});

// ---------------------------------------------------------------- command line

// The real CLI in its own process. Its Harness home, Harness folder and data
// folder are all throwaway; the plugin folder is this checkout's own. No
// process of the stand-in Harness folder exists, so the real process list
// reads as not running whether or not a real Harness is open on this machine.
function runCli(box, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, DSHPROXY_HOME: path.join(box.base, "data"), DSH_HOME: box.home, DSHPROXY_HARNESS_DIR: box.harness }
  });
}

const OWN_FOLDER = path.join(__dirname, "..", "integrations", "dsh-video");

test("dshproxy dsh bundle status --json prints the contract as one line and exits 0", (t) => {
  const box = sandbox(t);
  writeProfile(box);
  const before = snapshot(box.base);
  const result = runCli(box, ["dsh", "bundle", "status", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const found = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(found), CONTRACT_KEYS);
  assert.deepEqual(found, { harness: "found", harnessRunning: false, profile: "desktop", profileExists: true, bundle: "not-installed", folder: path.resolve(OWN_FOLDER), linkedTo: null, version: null, canInstall: true, canInstallAfterQuit: false, reason: "" });
  assert.deepEqual(snapshot(box.base), before);

  // It could look, so it exits 0 also when there is nothing to find.
  fs.rmSync(path.join(box.home, "profiles"), { recursive: true });
  const empty = runCli(box, ["dsh", "bundle", "status", "--json"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).profileExists, false);
  assert.equal(JSON.parse(empty.stdout).canInstall, false);
});

test("dshproxy dsh bundle status says in plain words what is so and what to do", (t) => {
  const box = sandbox(t);
  writeProfile(box);
  const ready = runCli(box, ["dsh", "bundle", "status"]);
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, /The video plugin is not installed in DeepSeek Harness\. Run `dshproxy dsh bundle install`/);

  fs.rmSync(path.join(box.home, "profiles"), { recursive: true });
  const never = runCli(box, ["dsh", "bundle", "status"]);
  assert.equal(never.status, 0, never.stderr);
  assert.match(never.stdout, /has not been opened/);
  assert.doesNotMatch(never.stdout, /^\{/);
});

test("a plugin switched off in the home-level patch: JSON and plain text both say where to switch it on", (t) => {
  const box = sandbox(t);
  writeProfile(box, { dependencies: { [NAME]: link(OWN_FOLDER) }, bundles: [...BASE_BUNDLES, NAME], homePatch: DISABLED });
  const before = snapshot(box.base);
  const json = runCli(box, ["dsh", "bundle", "status", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const found = JSON.parse(json.stdout);
  assert.equal(found.bundle, "switched-off");
  assert.equal(found.canInstall, false);
  assert.match(found.reason, /Switch it on under Plugins in DeepSeek Harness/);
  const text = runCli(box, ["dsh", "bundle", "status"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /switched off in DeepSeek Harness\. Switch it on under Plugins in DeepSeek Harness/);
  assert.deepEqual(snapshot(box.base), before);
});

test("each state is told in one or two sentences that end with what to do", async (t) => {
  const box = sandbox(t);
  const other = path.join(box.base, "older", "integrations", "dsh-video");
  fs.mkdirSync(other, { recursive: true });
  const gone = path.join(box.base, "gone", "dsh-video");
  const told = async (profile) => {
    writeProfile(box, profile);
    return bundle.describe(await bundle.state(deps(box)));
  };
  assert.equal(await told({ dependencies: { [NAME]: link(box.folder) }, bundles: [...BASE_BUNDLES, NAME] }), "The video plugin is installed in DeepSeek Harness (version 0.1.0).");
  assert.equal(await told({ dependencies: { [NAME]: link(box.folder) } }), "The video plugin is switched off in DeepSeek Harness. Switch it on under Plugins in DeepSeek Harness; DSHProxy leaves it as you set it.");
  assert.equal(await told({ dependencies: { [NAME]: link(other) } }), `DeepSeek Harness has the video plugin from another folder (${other}). Run \`dshproxy dsh bundle install\` to point it at ${box.folder}.`);
  assert.equal(await told({ dependencies: { [NAME]: link(gone) } }), `DeepSeek Harness points at a video plugin folder that is gone (${gone}). Run \`dshproxy dsh bundle install\` to point it at ${box.folder}.`);
});

test("dshproxy dsh bundle install --json installs once, and a second time changes nothing", (t) => {
  const box = sandbox(t);
  writeProfile(box);
  const first = runCli(box, ["dsh", "bundle", "install", "--json"]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(first.stdout.trim().split("\n").length, 1);
  const result = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(result), ["ok", "bundle", "message", "log"]);
  assert.equal(result.ok, true);
  assert.equal(result.bundle, "installed");
  assert.equal(result.log, path.join(box.base, "data", "dsh-bundle-install.log"));
  assert.deepEqual(calls(box.harness).map((call) => call.argv), [["plugin", "--profile", "desktop", "add", path.resolve(OWN_FOLDER)]]);
  assert.equal(calls(box.harness)[0].env.DSH_HOME, box.home);
  assert.equal(JSON.parse(runCli(box, ["dsh", "bundle", "status", "--json"]).stdout).bundle, "installed");

  const profileAfterFirst = fs.readFileSync(path.join(profileDir(box), "package.json"), "utf8");
  const second = runCli(box, ["dsh", "bundle", "install", "--json"]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { ok: true, bundle: "installed", message: JSON.parse(second.stdout).message, log: null });
  assert.equal(calls(box.harness).length, 1);
  assert.equal(fs.readFileSync(path.join(profileDir(box), "package.json"), "utf8"), profileAfterFirst);
});

test("dshproxy dsh bundle install exits 1 with the reason and runs nothing when it cannot install", (t) => {
  const box = sandbox(t);
  const json = runCli(box, ["dsh", "bundle", "install", "--json"]);
  assert.equal(json.status, 1);
  const result = JSON.parse(json.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.bundle, "not-installed");
  assert.match(result.message, /has not been opened/);
  assert.equal(result.log, null);

  const text = runCli(box, ["dsh", "bundle", "install"]);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /has not been opened/);
  assert.deepEqual(calls(box.harness), []);
  assert.equal(fs.existsSync(path.join(box.home, "profiles")), false);
});

test("dshproxy dsh bundle install exits 1 when the command fails", (t) => {
  const box = sandbox(t, { standIn: "fail" });
  writeProfile(box);
  const result = runCli(box, ["dsh", "bundle", "install", "--json"]);
  assert.equal(result.status, 1);
  const answer = JSON.parse(result.stdout);
  assert.equal(answer.ok, false);
  assert.match(answer.message, /dsh: plugin command failed/);
  assert.equal(calls(box.harness).length, 1);
});

test("the help names both bundle commands, and an unknown one is refused", (t) => {
  const box = sandbox(t);
  const help = runCli(box, ["help"]);
  assert.match(help.stdout, /^ {2}dshproxy dsh bundle status \[--json\] {2}\S/m);
  assert.match(help.stdout, /^ {2}dshproxy dsh bundle install \[--json\] \S/m);
  const bad = runCli(box, ["dsh", "bundle", "upgrade"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage: dshproxy dsh bundle status\|install \[--json\]/);
  assert.deepEqual(calls(box.harness), []);
});
