const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const YAML = require("yaml");

const { render } = require("../src/backend/config");
const { install, binaryPath, assetFor } = require("../src/backend/install");
const { reclaimOrphan, createSupervisor } = require("../src/backend/supervisor");
const http = require("http");
const secrets = require("../src/secrets");
const accounts = require("../src/accounts");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-backend-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const BASE = { host: "127.0.0.1", port: 8418, authDir: "C:\\Users\\someone\\.dshproxy\\auth", requestRetry: 3 };

test("the backend listens on this machine only, with management switched off", () => {
  const config = YAML.parse(render(BASE));
  assert.equal(config["config-version"], 8);
  assert.deepEqual(config.server, { host: "127.0.0.1", port: 8418 });
  assert.equal(config.management["secret-key"], "");
  assert.equal(config.management["allow-remote"], false);
  assert.equal(config.plugins.enabled, false);
  assert.equal(config.oauth["auth-dir"], BASE.authDir);
});

test("a management key switches the Management API on for this machine only", () => {
  const config = YAML.parse(render({ ...BASE, managementKey: "k".repeat(64) }));
  assert.equal(config.management["secret-key"], "k".repeat(64));
  assert.equal(config.management["allow-remote"], false);
  assert.equal(config.management["disable-control-panel"], true);
});

test("account details give the IDs a usage call needs and never a token", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "codex-a.json"), JSON.stringify({ type: "codex", account_id: "acct-1", plan_type: "pro", access_token: "tok-a", refresh_token: "tok-b" }));
  fs.writeFileSync(path.join(dir, "antigravity-b.json"), JSON.stringify({ type: "antigravity", project_id: "proj-1", access_token: "tok-c" }));
  assert.deepEqual(accounts.details(dir, "codex-a.json"), { accountId: "acct-1", projectId: null, plan: "pro" });
  assert.deepEqual(accounts.details(dir, "antigravity-b.json"), { accountId: null, projectId: "proj-1", plan: null });
  assert.equal(accounts.details(dir, "..\\codex-a.json"), null);
  assert.equal(accounts.details(dir, "missing.json"), null);
});

test("the backend never blacks out a credential on its own", () => {
  const config = YAML.parse(render(BASE));
  assert.equal(config.routing.cooldown["disable-cooling"], true);
  assert.equal(config.routing["session-affinity"], true);
  assert.equal(config.routing.retry["request-retry"], 3);
});

test("no API-key section is written when no key is configured", () => {
  assert.equal(YAML.parse(render(BASE))["api-keys"], undefined);
});

test("an API-key provider becomes a prefixed group with its models and levels", () => {
  const config = YAML.parse(render({ ...BASE, providers: { deepseek: { region: "international", apiKey: "sk-test-1" } } }));
  assert.deepEqual(config["api-keys"]["openai-compatibility"], [{
    name: "deepseek",
    prefix: "deepseek",
    "base-url": "https://api.deepseek.com",
    keys: [{ "api-key": "sk-test-1" }],
    models: [
      { name: "deepseek-v4-pro", alias: "deepseek-v4-pro", "display-name": "DeepSeek V4 Pro", thinking: { levels: ["low", "high", "max"] } },
      { name: "deepseek-flash", alias: "deepseek-flash", "display-name": "DeepSeek V4.1 Flash", thinking: { levels: ["low", "high", "max"] } }
    ]
  }]);
});

test("a provider's region picks its endpoint and model list", () => {
  const group = (region) => YAML.parse(render({ ...BASE, providers: { qwen: { region, apiKey: "sk-test" } } }))["api-keys"]["openai-compatibility"][0];
  assert.equal(group("tokenplan")["base-url"], "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1");
  assert.deepEqual(group("tokenplan").models.map((model) => model.name), ["qwen3.8-max", "qwen3.8-flash", "glm-5.3", "deepseek-v4-pro"]);
  assert.equal(group("china")["base-url"], "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.deepEqual(group("china").models.map((model) => model.name), ["qwen3.8-max", "qwen3.8-flash"]);
});

test("a model without reasoning levels declares none", () => {
  const group = YAML.parse(render({ ...BASE, providers: { mistral: { region: "eu", apiKey: "k" } } }))["api-keys"]["openai-compatibility"][0];
  assert.equal(group.models[0].thinking, undefined);
});

test("an API key with YAML syntax in it survives unchanged", () => {
  const apiKey = 'sk: "quoted" #hash \\ {brace}';
  const config = YAML.parse(render({ ...BASE, providers: { deepseek: { region: "international", apiKey } } }));
  assert.equal(config["api-keys"]["openai-compatibility"][0].keys[0]["api-key"], apiKey);
});

function makeZip(dir, nested) {
  const source = path.join(dir, "payload", nested || "");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "cli-proxy-api.exe"), "fake backend binary");
  const zip = path.join(dir, "release.zip");
  execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-a", "-cf", zip, "-C", path.join(dir, "payload"), "."]);
  return { zip, sha256: crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex") };
}

const lockFor = (sha256) => ({ name: "CLIProxyAPI", version: "9.9.9", assets: { [`${process.platform}-${process.arch}`]: { url: "https://example.invalid/release.zip", sha256 } } });

test("a download whose checksum matches is installed", async (t) => {
  const dir = tempDir(t);
  const { zip, sha256 } = makeZip(dir);
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  const result = await install(lockFor(sha256), binDir, { download: async (_url, file) => fs.copyFileSync(zip, file) });
  assert.equal(result.installed, true);
  assert.equal(result.path, binaryPath(lockFor(sha256), binDir));
  assert.equal(fs.readFileSync(result.path, "utf8"), "fake backend binary");
});

test("a binary inside a subfolder of the download is found", async (t) => {
  const dir = tempDir(t);
  const { zip, sha256 } = makeZip(dir, "CLIProxyAPI_9.9.9");
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  const result = await install(lockFor(sha256), binDir, { download: async (_url, file) => fs.copyFileSync(zip, file) });
  assert.equal(fs.readFileSync(result.path, "utf8"), "fake backend binary");
});

test("a download whose checksum does not match is rejected and nothing is installed", async (t) => {
  const dir = tempDir(t);
  const { zip } = makeZip(dir);
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  const lock = lockFor("0".repeat(64));
  await assert.rejects(install(lock, binDir, { download: async (_url, file) => fs.copyFileSync(zip, file) }), /Checksum mismatch/);
  assert.equal(fs.existsSync(binaryPath(lock, binDir)), false);
  assert.deepEqual(fs.readdirSync(binDir), []);
});

test("an installed version is not downloaded again", async (t) => {
  const dir = tempDir(t);
  const { zip, sha256 } = makeZip(dir);
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  const lock = lockFor(sha256);
  let downloads = 0;
  const download = async (_url, file) => {
    downloads += 1;
    fs.copyFileSync(zip, file);
  };
  await install(lock, binDir, { download });
  const second = await install(lock, binDir, { download });
  assert.equal(second.installed, false);
  assert.equal(downloads, 1);
});

test("a platform without a pinned download is refused", () => {
  assert.throws(() => assetFor({ name: "CLIProxyAPI", version: "9.9.9", assets: {} }, "win32", "x64"), /no pinned download for win32-x64/);
});

test("the pinned release is the official one and has a full checksum", () => {
  const lock = require("../backend.lock.json");
  for (const asset of Object.values(lock.assets)) {
    assert.match(asset.url, new RegExp(`^https://github\\.com/router-for-me/CLIProxyAPI/releases/download/v${lock.version.replaceAll(".", "\\.")}/`));
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
});

test("a backend left behind by a gateway that was killed is stopped", async (t) => {
  const dir = tempDir(t);
  const pidFile = path.join(dir, "backend.pid");
  const binary = path.join(dir, "bin", "8.0.72", "cli-proxy-api.exe");
  fs.writeFileSync(pidFile, "4321\n");
  const killed = [];
  // Windows reports paths with its own capitalisation.
  const reclaimed = await reclaimOrphan({ pidFile, binary, processPath: async () => binary.toUpperCase(), kill: (pid) => killed.push(pid) });
  assert.equal(reclaimed, true);
  assert.deepEqual(killed, [4321]);
});

test("a process that is not this gateway's backend is never stopped", async (t) => {
  const dir = tempDir(t);
  const pidFile = path.join(dir, "backend.pid");
  const binary = path.join(dir, "bin", "8.0.72", "cli-proxy-api.exe");
  const killed = [];
  const kill = (pid) => killed.push(pid);

  // The recorded process ID now belongs to another program's cli-proxy-api.exe.
  fs.writeFileSync(pidFile, "4321\n");
  assert.equal(await reclaimOrphan({ pidFile, binary, processPath: async () => "C:\\Users\\someone\\AppData\\Roaming\\droidproxy-windows\\runtime\\bin\\cli-proxy-api.exe", kill }), false);
  // The recorded process is gone.
  fs.writeFileSync(pidFile, "4321\n");
  assert.equal(await reclaimOrphan({ pidFile, binary, processPath: async () => null, kill }), false);
  // Nothing was recorded, or the record is not a process ID.
  fs.rmSync(pidFile, { force: true });
  assert.equal(await reclaimOrphan({ pidFile, binary, processPath: async () => binary, kill }), false);
  fs.writeFileSync(pidFile, "not-a-pid\n");
  assert.equal(await reclaimOrphan({ pidFile, binary, processPath: async () => binary, kill }), false);

  assert.deepEqual(killed, []);
});

test("a port held by another program stops the start and leaves that program running", async (t) => {
  const other = http.createServer((_req, res) => res.end("other program"));
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    other.closeAllConnections();
    other.close();
  });
  const { port } = other.address();
  const dir = tempDir(t);
  const supervisor = createSupervisor({ binary: path.join(dir, "cli-proxy-api.exe"), configPath: path.join(dir, "config.yaml"), host: "127.0.0.1", port, pidFile: path.join(dir, "backend.pid") });
  await assert.rejects(supervisor.start(), /already in use/);
  assert.equal(supervisor.state().running, false);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "other program");
});

test("a saved key decrypts with its key and with no other", () => {
  const key = crypto.randomBytes(32);
  const encoded = secrets.encryptWithKey(key, "sk-secret-value");
  assert.ok(!encoded.includes("sk-secret-value"));
  assert.equal(secrets.decryptWithKey(key, encoded), "sk-secret-value");
  assert.equal(secrets.decryptWithKey(crypto.randomBytes(32), encoded), null);
  assert.equal(secrets.decryptWithKey(key, "not-a-saved-key"), null);
  assert.equal(secrets.decryptWithKey(key, ""), null);
});

test("the same key encrypts differently each time", () => {
  const key = crypto.randomBytes(32);
  assert.notEqual(secrets.encryptWithKey(key, "same"), secrets.encryptWithKey(key, "same"));
});

test("the master key survives a restart and is not stored in the clear", async (t) => {
  const file = path.join(tempDir(t), "master.key");
  assert.equal(await secrets.loadMasterKey(file), null);
  const created = await secrets.loadMasterKey(file, { create: true });
  assert.equal(created.length, 32);
  assert.ok(!fs.readFileSync(file).includes(created));
  const reloaded = await secrets.loadMasterKey(file);
  assert.ok(reloaded.equals(created));
});

test("a master key file Windows cannot unlock is an error and is left in place", async (t) => {
  const file = path.join(tempDir(t), "master.key");
  fs.writeFileSync(file, "bm90IGEgZHBhcGkgYmxvYg==\n");
  await assert.rejects(secrets.loadMasterKey(file, { create: true }), /could not unlock/);
  assert.equal(fs.readFileSync(file, "utf8"), "bm90IGEgZHBhcGkgYmxvYg==\n");
});

test("accounts are listed from the credential files without their tokens", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "claude-a.json"), JSON.stringify({ type: "claude", email: "a@example.com", access_token: "tok-1", refresh_token: "tok-2", expired: "2026-12-01T00:00:00Z" }));
  fs.writeFileSync(path.join(dir, "codex-b.json"), JSON.stringify({ type: "codex", email: "b@example.com", disabled: true, access_token: "tok-3" }));
  fs.writeFileSync(path.join(dir, "other.json"), JSON.stringify({ type: "unknown-provider" }));
  fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
  const listed = accounts.list(dir);
  assert.deepEqual(listed, [
    { file: "claude-a.json", provider: "claude", label: "Claude", account: "a@example.com", disabled: false, expired: "2026-12-01T00:00:00.000Z" },
    { file: "codex-b.json", provider: "codex", label: "ChatGPT (Codex)", account: "b@example.com", disabled: true, expired: null }
  ]);
  assert.ok(!JSON.stringify(listed).includes("tok-"));
  // A disabled account does not make its provider available.
  assert.deepEqual([...accounts.activeProviders(dir)], ["claude"]);
});

test("a missing credential folder lists no accounts", (t) => {
  assert.deepEqual(accounts.list(path.join(tempDir(t), "absent")), []);
});
