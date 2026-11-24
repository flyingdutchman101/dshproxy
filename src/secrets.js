// API keys are stored encrypted (AES-256-GCM) with a random master key. The
// master key is kept on disk wrapped by Windows DPAPI for the current user, so
// the settings file is useless on another account or machine.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { createIfAbsent } = require("./filelock");

const VERSION = Buffer.from("dg1");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function encryptWithKey(key, plain) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return Buffer.concat([VERSION, nonce, body, cipher.getAuthTag()]).toString("base64");
}

// Returns the plaintext, or null when `encoded` was not made with `key`.
function decryptWithKey(key, encoded) {
  const encrypted = Buffer.from(String(encoded || ""), "base64");
  if (encrypted.length < VERSION.length + NONCE_BYTES + TAG_BYTES) return null;
  if (!encrypted.subarray(0, VERSION.length).equals(VERSION)) return null;
  try {
    const nonce = encrypted.subarray(VERSION.length, VERSION.length + NONCE_BYTES);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(encrypted.subarray(encrypted.length - TAG_BYTES));
    const body = encrypted.subarray(VERSION.length + NONCE_BYTES, encrypted.length - TAG_BYTES);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const PROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$key = [Convert]::FromBase64String($env:DSHPROXY_DPAPI_KEY)",
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($key, $null, 'CurrentUser'))"
].join("; ");

// The unwrapped key is XORed with a one-time mask before PowerShell prints it,
// so a machine that records PowerShell output never records the key itself.
const UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$key = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:DSHPROXY_DPAPI_BLOB), $null, 'CurrentUser')",
  "$mask = [Convert]::FromBase64String($env:DSHPROXY_DPAPI_MASK)",
  "if ($key.Length -ne $mask.Length) { exit 3 }",
  "for ($i = 0; $i -lt $key.Length; $i++) { $key[$i] = $key[$i] -bxor $mask[$i] }",
  "[Convert]::ToBase64String($key)"
].join("; ");

function powershell(script, env) {
  const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve) => {
    execFile(exe, ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, ...env }, windowsHide: true, timeout: 20000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim());
    });
  });
}

async function unwrap(blob) {
  const mask = crypto.randomBytes(KEY_BYTES);
  const output = await powershell(UNPROTECT_SCRIPT, { DSHPROXY_DPAPI_BLOB: blob, DSHPROXY_DPAPI_MASK: mask.toString("base64") });
  const masked = Buffer.from(output || "", "base64");
  if (masked.length !== KEY_BYTES) return null;
  return Buffer.from(masked.map((byte, index) => byte ^ mask[index]));
}

async function unlockMasterKey(file) {
  const key = await unwrap(fs.readFileSync(file, "utf8").trim());
  if (!key) throw new Error(`Windows could not unlock ${file}. Saved API keys cannot be read from this account.`);
  return key;
}

// Returns the master key. With `create`, a missing key file is created; without
// it a missing file returns null. An existing file that Windows will not unlock
// is an error and is never replaced, because replacing it would make every
// saved API key unreadable for good.
//
// Several commands can find the file missing at the same moment. Each makes a
// key, but only one file is put in place, whole and in one step, and it is
// never written again: the others drop their key and use the one in the file.
// Otherwise each would encrypt with a key that the next one overwrites.
async function loadMasterKey(file, { create = false, keywrap = null } = {}) {
  if (keywrap || process.platform === "darwin") return loadWrappedMasterKey(file, { create, keywrap: keywrap || require("./keywrap-darwin").defaultKeywrap() });
  if (fs.existsSync(file)) return unlockMasterKey(file);
  if (!create) return null;
  const key = crypto.randomBytes(KEY_BYTES);
  const blob = await powershell(PROTECT_SCRIPT, { DSHPROXY_DPAPI_KEY: key.toString("base64") });
  if (!blob) throw new Error("Windows could not protect a new key, so nothing was saved.");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (createIfAbsent(file, `${blob}\n`)) return key;
  return unlockMasterKey(file);
}

// The same, on macOS: the key file holds the master key wrapped by
// `keywrap` (src/keywrap-darwin.js, the Keychain) where Windows has a DPAPI
// blob. The same rules: a file that cannot be unwrapped is an error and is
// never replaced, and of several first uses one file is put in place.
async function unlockWrapped(file, keywrap) {
  const key = await keywrap.unwrap(fs.readFileSync(file, "utf8"));
  if (!key || key.length !== KEY_BYTES) throw new Error(`macOS could not unlock ${file}. Saved API keys cannot be read from this account.`);
  return key;
}

async function loadWrappedMasterKey(file, { create, keywrap }) {
  if (fs.existsSync(file)) return unlockWrapped(file, keywrap);
  if (!create) return null;
  const key = crypto.randomBytes(KEY_BYTES);
  const wrapped = await keywrap.wrap(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (createIfAbsent(file, `${wrapped}\n`)) return key;
  return unlockWrapped(file, keywrap);
}

module.exports = { encryptWithKey, decryptWithKey, loadMasterKey };
