// Installs the CLIProxyAPI release named in backend.lock.json. The download is
// accepted only when its SHA-256 matches the lock file.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

// The program in the release archive: a .zip on Windows, a .tar.gz on macOS.
const BINARY = process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";

function assetFor(lock, platform = process.platform, arch = process.arch) {
  const asset = lock.assets?.[`${platform}-${arch}`];
  if (!asset) throw new Error(`${lock.name} ${lock.version} has no pinned download for ${platform}-${arch}.`);
  return asset;
}

function binaryPath(lock, binDir) {
  return path.join(binDir, lock.version, BINARY);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

async function downloadTo(url, file) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
}

// Each system's own tar: Windows ships one in System32, macOS in /usr/bin.
function extract(zip, dir) {
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
  return new Promise((resolve, reject) => {
    execFile(tar, ["-xf", zip, "-C", dir], { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`Could not unpack ${path.basename(zip)}: ${String(stderr).trim() || error.message}`));
      else resolve();
    });
  });
}

function findBinary(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === BINARY) return full;
    if (entry.isDirectory()) {
      const nested = findBinary(full);
      if (nested) return nested;
    }
  }
  return null;
}

// `download(url, file)` is replaceable so tests need no network.
async function install(lock, binDir, { download = downloadTo, log = () => {} } = {}) {
  const target = binaryPath(lock, binDir);
  if (fs.existsSync(target)) return { path: target, installed: false };

  const asset = assetFor(lock);
  const dir = path.dirname(target);
  const staging = `${dir}.staging`;
  const zip = path.join(binDir, `${lock.version}${process.platform === "win32" ? ".zip" : ".tar.gz"}.part`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    log(`Downloading ${lock.name} ${lock.version}`);
    await download(asset.url, zip);
    const actual = await sha256File(zip);
    if (actual !== asset.sha256) {
      throw new Error(`Checksum mismatch for ${lock.name} ${lock.version}: expected ${asset.sha256}, got ${actual}. Nothing was installed.`);
    }
    await extract(zip, staging);
    const found = findBinary(staging);
    if (!found) throw new Error(`${BINARY} was not found in the ${lock.name} ${lock.version} download.`);
    if (found !== path.join(staging, BINARY)) fs.renameSync(found, path.join(staging, BINARY));
    // On macOS the program is made runnable, by this account only.
    if (process.platform !== "win32") fs.chmodSync(path.join(staging, BINARY), 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    return { path: target, installed: true };
  } finally {
    fs.rmSync(zip, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { install, binaryPath, assetFor, sha256File };
