const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { compareVersions, parseChecksums, lockFromRelease, checkForUpdate, createUpdater } = require("../src/backend/updater");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dshgate-updater-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CURRENT = { name: "CLIProxyAPI", version: "8.0.72", source: "https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.72", assets: { "win32-x64": { url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.72/CLIProxyAPI_8.0.72_windows_amd64.zip", sha256: "a".repeat(64) } } };

// The release v8.0.75 as GitHub's API returned it on 2026-11-16 (trimmed).
const RELEASE = {
  tag_name: "v8.0.75",
  published_at: "2026-11-16T09:12:24Z",
  draft: false,
  prerelease: false,
  html_url: "https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.75",
  assets: [
    { name: "checksums.txt", browser_download_url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.75/checksums.txt" },
    { name: "CLIProxyAPI_8.0.75_windows_aarch64.zip", browser_download_url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.75/CLIProxyAPI_8.0.75_windows_aarch64.zip" },
    { name: "CLIProxyAPI_8.0.75_windows_amd64.zip", browser_download_url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.75/CLIProxyAPI_8.0.75_windows_amd64.zip" },
    { name: "CLIProxyAPI_8.0.75_linux_amd64.tar.gz", browser_download_url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.75/CLIProxyAPI_8.0.75_linux_amd64.tar.gz" }
  ]
};
const CHECKSUMS = [
  "6961226bddb3dbe54bcc8f247b0a7a97ed92053ee69c2de1448181e89d586532  CLIProxyAPI_8.0.75_windows_aarch64.zip",
  "e83abd952ee2053414f20bb0b01268d98fc7cb4a4b04a645cbbbc72e66b7bd05  CLIProxyAPI_8.0.75_windows_amd64.zip",
  "0000000000000000000000000000000000000000000000000000000000000000  CLIProxyAPI_8.0.75_linux_amd64.tar.gz",
  ""
].join("\n");

// A stand-in for GitHub: answers the release API and the checksums file.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const body = routes[String(url)];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    return { ok: true, status: 200, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  impl.calls = calls;
  return impl;
}

const LATEST = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest";
const SUMS = "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.75/checksums.txt";

test("versions compare by number, not as text", () => {
  assert.ok(compareVersions("8.0.75", "8.0.72") > 0);
  assert.ok(compareVersions("8.0.100", "8.0.99") > 0);
  assert.ok(compareVersions("8.1.0", "8.0.99") > 0);
  assert.equal(compareVersions("v8.0.72", "8.0.72"), 0);
  assert.ok(compareVersions("8.0.71", "8.0.72") < 0);
});

test("the release's checksum file is read into a name-to-hash map", () => {
  const sums = parseChecksums(CHECKSUMS);
  assert.equal(sums.get("CLIProxyAPI_8.0.75_windows_amd64.zip"), "e83abd952ee2053414f20bb0b01268d98fc7cb4a4b04a645cbbbc72e66b7bd05");
  assert.equal(sums.size, 3);
  assert.equal(parseChecksums("not a checksum line\n\nabc  short.zip").size, 0);
});

test("a release becomes a lock with both Windows downloads and their checksums", () => {
  const lock = lockFromRelease(RELEASE, parseChecksums(CHECKSUMS));
  assert.deepEqual(lock, {
    name: "CLIProxyAPI",
    version: "8.0.75",
    source: "https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.75",
    publishedAt: "2026-11-16T09:12:24Z",
    assets: {
      "win32-x64": { url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.75/CLIProxyAPI_8.0.75_windows_amd64.zip", sha256: "e83abd952ee2053414f20bb0b01268d98fc7cb4a4b04a645cbbbc72e66b7bd05" },
      "win32-arm64": { url: "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.75/CLIProxyAPI_8.0.75_windows_aarch64.zip", sha256: "6961226bddb3dbe54bcc8f247b0a7a97ed92053ee69c2de1448181e89d586532" }
    }
  });
});

test("a release without a checksum for a Windows download is refused", () => {
  const sums = parseChecksums(CHECKSUMS.split("\n").filter((line) => !line.includes("windows_amd64")).join("\n"));
  assert.throws(() => lockFromRelease(RELEASE, sums), /no checksum for CLIProxyAPI_8.0.75_windows_amd64.zip/);
});

test("a download address outside the official release is refused", () => {
  const forged = { ...RELEASE, assets: RELEASE.assets.map((asset) => (asset.name.endsWith("windows_amd64.zip") ? { ...asset, browser_download_url: "https://evil.example/CLIProxyAPI_8.0.75_windows_amd64.zip" } : asset)) };
  assert.throws(() => lockFromRelease(forged, parseChecksums(CHECKSUMS)), /not an official CLIProxyAPI download/);
});

test("a newer release is reported with its lock; the same or an older one is not", async () => {
  const fetchImpl = fakeFetch({ [LATEST]: RELEASE, [SUMS]: CHECKSUMS });
  const update = await checkForUpdate(CURRENT, { fetchImpl });
  assert.equal(update.available, true);
  assert.equal(update.lock.version, "8.0.75");
  assert.equal(update.current, "8.0.72");

  const same = await checkForUpdate({ ...CURRENT, version: "8.0.75" }, { fetchImpl: fakeFetch({ [LATEST]: RELEASE }) });
  assert.deepEqual(same, { available: false, current: "8.0.75", latest: "8.0.75" });
});

test("a draft or pre-release is never offered", async () => {
  for (const flag of ["draft", "prerelease"]) {
    const update = await checkForUpdate(CURRENT, { fetchImpl: fakeFetch({ [LATEST]: { ...RELEASE, [flag]: true } }) });
    assert.equal(update.available, false, flag);
  }
});

// The updater with every outside step replaced: installing, the trial run,
// and the switch. `trial` decides whether the new version passes.
function makeUpdater(t, { trial = async () => ({ ok: true, checks: ["claude-haiku-5-5: ok"] }), install } = {}) {
  const dir = tempDir(t);
  const lockFile = path.join(dir, "backend.lock.json");
  fs.writeFileSync(lockFile, `${JSON.stringify(CURRENT, null, 2)}\n`);
  const events = [];
  const updater = createUpdater({
    lockFile,
    binDir: path.join(dir, "bin"),
    install: install || (async (lock) => {
      events.push(`install ${lock.version}`);
      return { path: path.join(dir, "bin", lock.version, "cli-proxy-api.exe"), installed: true };
    }),
    trial: async (binary, lock) => {
      events.push(`trial ${lock.version}`);
      return trial(binary, lock);
    },
    restart: async () => events.push("restart")
  });
  return { updater, lockFile, events, readLock: () => JSON.parse(fs.readFileSync(lockFile, "utf8")) };
}

const NEXT = { ...lockFromRelease(RELEASE, parseChecksums(CHECKSUMS)) };

test("an update installs, passes its trial, switches, and keeps the old version for rollback", async (t) => {
  const { updater, events, readLock } = makeUpdater(t);
  const result = await updater.apply(NEXT);
  assert.equal(result.ok, true);
  assert.deepEqual(events, ["install 8.0.75", "trial 8.0.75", "restart"]);
  assert.equal(readLock().version, "8.0.75");
  assert.equal(readLock().previous.version, "8.0.72");
});

test("an update that fails its trial changes nothing", async (t) => {
  const { updater, events, readLock } = makeUpdater(t, { trial: async () => ({ ok: false, checks: ["claude-haiku-5-5: HTTP 500"] }) });
  const result = await updater.apply(NEXT);
  assert.equal(result.ok, false);
  assert.match(result.message, /did not pass/);
  assert.deepEqual(result.checks, ["claude-haiku-5-5: HTTP 500"]);
  assert.deepEqual(events, ["install 8.0.75", "trial 8.0.75"]);
  assert.equal(readLock().version, "8.0.72");
});

test("an update whose download fails its checksum changes nothing", async (t) => {
  const { updater, readLock } = makeUpdater(t, { install: async () => { throw new Error("Checksum mismatch for CLIProxyAPI 8.0.75"); } });
  const result = await updater.apply(NEXT);
  assert.equal(result.ok, false);
  assert.match(result.message, /Checksum mismatch/);
  assert.equal(readLock().version, "8.0.72");
});

test("rolling back returns to the previous version and restarts", async (t) => {
  const { updater, events, readLock } = makeUpdater(t);
  await updater.apply(NEXT);
  events.length = 0;
  const result = await updater.rollback();
  assert.equal(result.ok, true);
  assert.equal(readLock().version, "8.0.72");
  assert.equal(readLock().previous, undefined);
  assert.deepEqual(events, ["restart"]);
});

test("rolling back with no previous version is refused", async (t) => {
  const { updater, events } = makeUpdater(t);
  await assert.rejects(updater.rollback(), /no previous version/);
  assert.deepEqual(events, []);
});

test("a rollback cannot run while an update is in its trial", async (t) => {
  let release;
  const { updater, readLock } = makeUpdater(t, { trial: () => new Promise((resolve) => { release = () => resolve({ ok: true, checks: [] }); }) });
  const first = updater.apply(NEXT);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(updater.rollback(), /already running/);
  release();
  await first;
  assert.equal(readLock().version, "8.0.75");
});

test("a rollback below the shipped version is refused", async (t) => {
  const dir = tempDir(t);
  const lockFile = path.join(dir, "backend.lock.json");
  fs.writeFileSync(lockFile, JSON.stringify({ ...NEXT, previous: CURRENT }));
  const events = [];
  const updater = createUpdater({ lockFile, binDir: dir, install: async () => ({}), trial: async () => ({ ok: true }), restart: async () => events.push("restart"), floor: "8.0.75" });
  await assert.rejects(updater.rollback(), /older than the version this dshgate ships with/);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).version, "8.0.75");
  assert.deepEqual(events, []);
});

test("an update starts from the version actually running, not a stale lock file", async (t) => {
  const dir = tempDir(t);
  const lockFile = path.join(dir, "backend.lock.json");
  fs.writeFileSync(lockFile, JSON.stringify({ ...CURRENT, version: "8.0.60" }));
  const updater = createUpdater({ lockFile, binDir: dir, install: async () => ({ path: "x" }), trial: async () => ({ ok: true }), restart: async () => {}, current: () => CURRENT });
  await updater.apply(NEXT);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).previous.version, "8.0.72");
});

test("without a way to restart, nothing is downloaded or switched", async (t) => {
  const dir = tempDir(t);
  const lockFile = path.join(dir, "backend.lock.json");
  fs.writeFileSync(lockFile, JSON.stringify(CURRENT));
  let installed = false;
  const updater = createUpdater({ lockFile, binDir: dir, install: async () => { installed = true; return {}; }, trial: async () => ({ ok: true }), restart: null });
  const result = await updater.apply(NEXT);
  assert.equal(result.ok, false);
  assert.match(result.message, /cannot restart/);
  assert.equal(installed, false);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).version, "8.0.72");
});

test("a release whose version is not plain numbers is refused", () => {
  assert.throws(() => lockFromRelease({ ...RELEASE, tag_name: "v8.0.75/../../x" }, parseChecksums(CHECKSUMS)), /not a release version/);
});

test("only one update runs at a time", async (t) => {
  let release;
  const { updater } = makeUpdater(t, { trial: () => new Promise((resolve) => { release = () => resolve({ ok: true, checks: [] }); }) });
  const first = updater.apply(NEXT);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(updater.apply(NEXT), /already running/);
  release();
  await first;
});
