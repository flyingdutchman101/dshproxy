// Updates the CLIProxyAPI version in backend.lock.json.
//
// An update is never switched to blindly: the new version is downloaded and
// checked against the checksum the release publishes, started on a spare
// port, and asked to answer through each signed-in account. Only if that
// trial passes does the lock change and the gateway restart. The version it
// replaces is kept, so a rollback is one step.

const fs = require("fs");

const REPO = "router-for-me/CLIProxyAPI";
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
// The archives of a release DSHProxy uses, per system and processor.
const ASSETS = [
  { suffix: "windows_amd64", ext: "zip", key: "win32-x64", platform: "win32" },
  { suffix: "windows_aarch64", ext: "zip", key: "win32-arm64", platform: "win32" },
  { suffix: "darwin_aarch64", ext: "tar.gz", key: "darwin-arm64", platform: "darwin" },
  { suffix: "darwin_amd64", ext: "tar.gz", key: "darwin-x64", platform: "darwin" }
];

function parts(version) {
  return String(version).replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

// "<sha256>  <file name>" per line, as goreleaser writes it.
function parseChecksums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

// The lock for a release. The archives of the system this runs on, for both
// processors, must be there, each with the checksum the release published, or
// the release is refused; on Windows that is the rule as it always was. The
// other system's archives are kept when they are complete, and left out
// otherwise. Every address must be under the official release path.
function lockFromRelease(release, sums, { platform = process.platform } = {}) {
  const version = String(release.tag_name).replace(/^v/, "");
  // The version becomes a folder name, so only plain release numbers pass.
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`"${release.tag_name}" is not a release version.`);
  if (!ASSETS.some((item) => item.platform === platform)) throw new Error(`CLIProxyAPI updates are not set up for ${platform}.`);
  const assets = {};
  for (const { suffix, ext, key, platform: system } of ASSETS) {
    const required = system === platform;
    const name = `CLIProxyAPI_${version}_${suffix}.${ext}`;
    const asset = (release.assets || []).find((item) => item.name === name);
    const url = asset ? String(asset.browser_download_url) : null;
    const sha256 = sums.get(name);
    if (!required) {
      if (asset && url.startsWith(`${DOWNLOAD_PREFIX}v${version}/`) && sha256) assets[key] = { url, sha256 };
      continue;
    }
    if (!asset) throw new Error(`Release ${version} has no ${name}.`);
    if (!url.startsWith(`${DOWNLOAD_PREFIX}v${version}/`)) throw new Error(`${url} is not an official CLIProxyAPI download.`);
    if (!sha256) throw new Error(`Release ${version} has no checksum for ${name}.`);
    assets[key] = { url, sha256 };
  }
  return { name: "CLIProxyAPI", version, source: `https://github.com/${REPO}/releases/tag/v${version}`, publishedAt: release.published_at || null, assets };
}

// Asks GitHub for the latest release. Returns { available, current, latest,
// lock?, publishedAt? }.
async function checkForUpdate(current, { fetchImpl = fetch, timeoutMs = 20000, platform = process.platform } = {}) {
  const response = await fetchImpl(LATEST_URL, { headers: { accept: "application/vnd.github+json", "user-agent": "DSHProxy" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}.`);
  const release = await response.json();
  const latest = String(release.tag_name || "").replace(/^v/, "");
  if (!latest || release.draft || release.prerelease || compareVersions(latest, current.version) <= 0) {
    return { available: false, current: current.version, latest: latest || current.version };
  }
  const sumsAsset = (release.assets || []).find((asset) => asset.name === "checksums.txt");
  if (!sumsAsset) throw new Error(`Release ${latest} publishes no checksums, so it is not offered.`);
  if (!String(sumsAsset.browser_download_url).startsWith(`${DOWNLOAD_PREFIX}v${latest}/`)) throw new Error(`The checksums for ${latest} are not an official CLIProxyAPI download.`);
  const sums = await fetchImpl(sumsAsset.browser_download_url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!sums.ok) throw new Error(`The checksums for ${latest} could not be downloaded (HTTP ${sums.status}).`);
  const lock = lockFromRelease(release, parseChecksums(await sums.text()), { platform });
  return { available: true, current: current.version, latest, publishedAt: lock.publishedAt, lock };
}

function readLock(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeLock(file, lock) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

// `install(lock)` downloads and checks a version; `trial(binary, lock)` runs
// it on a spare port and returns { ok, checks }; `restart()` restarts the
// gateway on the version now in the lock file. `current()` returns the lock
// actually running (the lock file can be older than the shipped version);
// `floor` is the shipped version, below which a rollback is refused.
function createUpdater({ lockFile, binDir, install, trial, restart, current: currentLock = () => readLock(lockFile), floor = null, log = () => {} }) {
  let running = false;

  async function apply(next) {
    if (running) throw new Error("An update is already running.");
    if (typeof restart !== "function") return { ok: false, message: "This gateway cannot restart itself, so it cannot switch versions. Start it from the DSHProxy app.", checks: [] };
    running = true;
    try {
      const current = currentLock();
      let installed;
      try {
        installed = await install(next, binDir);
      } catch (error) {
        return { ok: false, message: error.message, checks: [] };
      }
      log(`trying CLIProxyAPI ${next.version} on a spare port`);
      const result = await trial(installed.path, next);
      if (!result.ok) {
        log(`CLIProxyAPI ${next.version} did not pass its trial; staying on ${current.version}`);
        return { ok: false, message: `CLIProxyAPI ${next.version} did not pass its trial, so DSHProxy stays on ${current.version}.`, checks: result.checks || [] };
      }
      const { previous, ...currentWithoutPrevious } = current;
      writeLock(lockFile, { ...next, previous: currentWithoutPrevious });
      log(`switched to CLIProxyAPI ${next.version} (previous ${current.version} kept for rollback)`);
      await restart();
      return { ok: true, message: `Updated to CLIProxyAPI ${next.version}.`, checks: result.checks || [] };
    } finally {
      running = false;
    }
  }

  async function rollback() {
    if (running) throw new Error("An update is already running.");
    running = true;
    try {
      const current = readLock(lockFile);
      if (!current.previous) throw new Error("There is no previous version to go back to.");
      if (floor && compareVersions(current.previous.version, floor) < 0) throw new Error(`CLIProxyAPI ${current.previous.version} is older than the version this DSHProxy ships with (${floor}).`);
      writeLock(lockFile, current.previous);
      log(`rolled back from CLIProxyAPI ${current.version} to ${current.previous.version}`);
      await restart();
      return { ok: true, message: `Back on CLIProxyAPI ${current.previous.version}.` };
    } finally {
      running = false;
    }
  }

  return { apply, rollback, isRunning: () => running };
}

module.exports = { LATEST_URL, compareVersions, parseChecksums, lockFromRelease, checkForUpdate, createUpdater, readLock };
