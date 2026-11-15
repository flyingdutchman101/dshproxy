// API keys are stored encrypted (AES-256-GCM) with a random master key. The
// master key is kept on disk wrapped by Windows DPAPI for the current user, so
// the settings file is useless on another account or machine.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

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
  "$key = [Convert]::FromBase64String($env:DSHGATE_DPAPI_KEY)",
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($key, $null, 'CurrentUser'))"
].join("; ");

// The unwrapped key is XORed with a one-time mask before PowerShell prints it,
// so a machine that records PowerShell output never records the key itself.
const UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$key = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:DSHGATE_DPAPI_BLOB), $null, 'CurrentUser')",
  "$mask = [Convert]::FromBase64String($env:DSHGATE_DPAPI_MASK)",
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
  const output = await powershell(UNPROTECT_SCRIPT, { DSHGATE_DPAPI_BLOB: blob, DSHGATE_DPAPI_MASK: mask.toString("base64") });
  const masked = Buffer.from(output || "", "base64");
  if (masked.length !== KEY_BYTES) return null;
  return Buffer.from(masked.map((byte, index) => byte ^ mask[index]));
}

// Returns the master key. With `create`, a missing key file is created; without
// it a missing file returns null. An existing file that Windows will not unlock
// is an error and is never replaced, because replacing it would make every
// saved API key unreadable for good.
async function loadMasterKey(file, { create = false } = {}) {
  if (fs.existsSync(file)) {
    const key = await unwrap(fs.readFileSync(file, "utf8").trim());
    if (!key) throw new Error(`Windows could not unlock ${file}. Saved API keys cannot be read from this account.`);
    return key;
  }
  if (!create) return null;
  const key = crypto.randomBytes(KEY_BYTES);
  const blob = await powershell(PROTECT_SCRIPT, { DSHGATE_DPAPI_KEY: key.toString("base64") });
  if (!blob) throw new Error("Windows could not protect a new key, so nothing was saved.");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${blob}\n`);
  return key;
}

module.exports = { encryptWithKey, decryptWithKey, loadMasterKey };
