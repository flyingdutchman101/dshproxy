# The one real end-to-end run of `install` in src\dsh\bundle.js: DeepSeek
# Harness's own dsh.cmd, this checkout's integrations\dsh-video, and a Harness
# home that is a new folder under %TEMP%.
#
# Manual. It is a .ps1 so that `node --test` does not pick it up: it needs
# DeepSeek Harness installed. The process list is injected as empty, because
# the real check refuses while Harness is open; that injection exists only
# here, not as a switch of the command line.
#
# Nothing is written outside the new folder. The real Harness home is only
# hashed, before and after, to show it did not change.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\manual\dsh-bundle-real-run.ps1

$ErrorActionPreference = 'Stop'
$env:F1_ROOT = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$realProfile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$watched = @('package.json', 'pnpm-lock.yaml') | ForEach-Object { Join-Path $realProfile $_ } | Where-Object { Test-Path $_ }
$hashes = { ($watched | ForEach-Object { (Get-FileHash $_ -Algorithm SHA256).Hash }) -join ' ' }
$before = & $hashes

$js = @'
const fs = require("fs");
const os = require("os");
const path = require("path");
const root = process.env.F1_ROOT;
const bundle = require(path.join(root, "src", "dsh", "bundle"));
const own = path.join(root, "integrations", "dsh-video", "package.json");

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-real-run-"));
  const home = path.join(base, "home");
  if (!home.toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep)) throw new Error("not under the temporary folder: " + home);
  if (home.toLowerCase() === path.join(os.homedir(), ".dsh").toLowerCase()) throw new Error("this is the real Harness home");
  const profile = path.join(home, "profiles", "desktop");
  const link = path.join(profile, "node_modules", "@local", "dshproxy-video");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "package.json"), '{"name":"dsh-profile-desktop","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}');
  const deps = { home, root, processes: async () => [], logFile: path.join(base, "dsh-bundle-install.log") };
  try {
    console.log("home    : " + home);
    console.log("before  : " + JSON.stringify(await bundle.state(deps)));
    const started = Date.now();
    const result = await bundle.install(deps);
    console.log("install : " + JSON.stringify(result) + "  (" + (Date.now() - started) + " ms)");
    console.log("after   : " + JSON.stringify(await bundle.state(deps)));
    console.log("package.json after:\n" + fs.readFileSync(path.join(profile, "package.json"), "utf8").trimEnd());
    console.log("profile folder: " + fs.readdirSync(profile).join(", "));
    try {
      console.log("link    : " + link + " -> " + fs.readlinkSync(link));
    } catch (error) {
      console.log("link    : none (" + error.code + ")");
    }
    if (result.log) console.log("log " + result.log + ":\n" + fs.readFileSync(result.log, "utf8").trimEnd());
    const again = await bundle.install(deps);
    console.log("again   : " + JSON.stringify(again));
  } finally {
    // The profile holds a link into this checkout: the link is removed, never
    // what it points at. unlink does not remove a real folder.
    let stat = null;
    try {
      stat = fs.lstatSync(link);
    } catch { /* no link was made */ }
    if (stat && !stat.isSymbolicLink()) throw new Error("not a link, so nothing was removed; remove by hand: " + base);
    if (stat) {
      try {
        fs.unlinkSync(link);
      } catch {
        fs.rmdirSync(link);
      }
    }
    if (!fs.existsSync(own)) throw new Error("integrations\\dsh-video\\package.json is gone");
    fs.rmSync(base, { recursive: true, force: true });
    console.log("cleanup : " + (fs.existsSync(base) ? "FOLDER STILL THERE " + base : "throwaway folder removed") + "; integrations\\dsh-video\\package.json " + (fs.existsSync(own) ? "still exists" : "IS GONE"));
  }
})().catch((error) => {
  console.error("FAILED: " + error.message);
  process.exitCode = 1;
});
'@

$js | node -
$code = $LASTEXITCODE
$after = & $hashes
if ($before -eq $after) { "real profile ($($watched.Count) files hashed): unchanged" } else { "REAL PROFILE CHANGED: $before -> $after" }
exit $code
