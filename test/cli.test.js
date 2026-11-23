require("./support/keychain"); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const CLI = path.join(__dirname, "..", "bin", "dshproxy.js");

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// Runs the real CLI in its own process, with its data in a temporary folder.
function run(home, args, input = "") {
  return spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, DSHPROXY_HOME: home, DSH_HOME: path.join(home, "no-deepseek-harness") }
  });
}

test("an API key given to the CLI is stored encrypted, is usable, and is never shown", (t) => {
  const home = tempHome(t);
  const key = "sk-test-key-that-must-not-leak-0123456789";

  const set = run(home, ["key", "set", "deepseek"], `${key}\n`);
  assert.equal(set.status, 0, set.stderr);
  assert.ok(!set.stdout.includes(key) && !set.stderr.includes(key));
  for (const name of fs.readdirSync(home)) {
    const file = path.join(home, name);
    if (fs.statSync(file).isFile()) assert.ok(!fs.readFileSync(file, "utf8").includes(key), `${name} holds the key in the clear`);
  }

  // The saved key decrypts in a fresh process: its models are offered.
  const models = run(home, ["models"]);
  assert.equal(models.status, 0, models.stderr);
  assert.match(models.stdout, /^deepseek\/deepseek-v4-pro /m);
  assert.match(models.stdout, /^lane-main /m);
  assert.ok(!models.stdout.includes(key));

  const list = run(home, ["key", "list"]);
  assert.match(list.stdout, /^deepseek: DeepSeek - saved \(international\)/m);
  assert.ok(!list.stdout.includes(key));
});

test("the status for the Windows app is one JSON document without key values", (t) => {
  const home = tempHome(t);
  // A port nothing listens on, so a gateway running on this machine is not seen.
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ port: 65431, backendPort: 65432 }));
  const key = "sk-test-json-status-must-not-leak-9876543210";
  assert.equal(run(home, ["key", "set", "deepseek"], `${key}\n`).status, 0);
  const result = run(home, ["status", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(key));
  const status = JSON.parse(result.stdout);
  assert.equal(status.running, false);
  assert.deepEqual(status.apiKeys.readable, [{ provider: "deepseek", region: "international" }]);
  assert.deepEqual(status.loginProviders.map((item) => item.key), ["codex", "claude", "antigravity", "kimi"]);
  const main = status.lanes.find((lane) => lane.name === "main");
  assert.deepEqual(main.ladder.find((rung) => rung.model === "deepseek/deepseek-v4-pro"), { model: "deepseek/deepseek-v4-pro", available: true, coolingUntil: null });
  assert.equal(main.ladder.find((rung) => rung.model === "gpt-6-astra").available, false);
  assert.ok(status.models.includes("lane-main"));
});

test("an empty API key is refused and nothing is saved", (t) => {
  const home = tempHome(t);
  const set = run(home, ["key", "set", "deepseek"], "\n");
  assert.equal(set.status, 1);
  assert.match(set.stderr, /No API key was given/);
  assert.equal(fs.existsSync(path.join(home, "settings.json")), false);
});

test("an unknown API-key provider is refused", (t) => {
  const set = run(tempHome(t), ["key", "set", "nobody"], "sk-whatever\n");
  assert.equal(set.status, 1);
  assert.match(set.stderr, /Unknown provider "nobody"/);
});

test("a settings file that cannot be read stops the CLI with its name", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, "settings.json"), "{broken");
  const status = run(home, ["status"]);
  assert.equal(status.status, 1);
  assert.match(status.stderr, /settings\.json/);
  assert.equal(fs.readFileSync(path.join(home, "settings.json"), "utf8"), "{broken");
});

test("routing presets can be listed and used from the command line", (t) => {
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ port: 65433, backendPort: 65434 }));
  const list = run(home, ["preset", "list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /Max performance/);
  assert.match(list.stdout, /Cheap production/);
  assert.match(list.stdout, /\* balanced/);
  for (const lane of ["main:", "scout:", "builder:", "architect:", "reviewer:"]) assert.ok(list.stdout.includes(lane), `list misses ${lane}`);

  const use = run(home, ["preset", "use", "cheap"]);
  assert.equal(use.status, 0, use.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
  assert.deepEqual(saved.lanes, require("../src/presets").get("cheap").lanes);

  const status = JSON.parse(run(home, ["status", "--json"]).stdout);
  assert.deepEqual(status.routing.active, { name: "cheap", label: "Cheap production" });
  assert.equal(status.routing.presets.length, 3);

  const bad = run(home, ["preset", "use", "fastest"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Unknown routing preset "fastest"/);
});

test("the primary account of a provider can be chosen and taken back from the command line", (t) => {
  const home = tempHome(t);
  fs.mkdirSync(path.join(home, "auth"), { recursive: true });
  // Sign-in files as the backend writes them; the tokens are not real.
  fs.writeFileSync(path.join(home, "auth", "claude-old@example.com.json"), JSON.stringify({ type: "claude", email: "old@example.com", access_token: "not-a-real-token" }));
  fs.writeFileSync(path.join(home, "auth", "claude-new@example.com.json"), JSON.stringify({ type: "claude", email: "new@example.com", access_token: "not-a-real-token" }));
  const stored = () => JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")).primary;

  const chosen = run(home, ["accounts", "primary", "claude", "new@example.com"]);
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.match(chosen.stdout, /new@example\.com is the primary Claude account/);
  assert.deepEqual(stored(), { claude: "claude-new@example.com.json" });

  const listed = run(home, ["accounts"]);
  assert.match(listed.stdout, /new@example\.com \(primary\)/);
  assert.doesNotMatch(listed.stdout, /old@example\.com \(primary\)/);
  assert.doesNotMatch(listed.stdout + chosen.stdout, /not-a-real-token/);

  const unknown = run(home, ["accounts", "primary", "claude", "nobody@example.com"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /No Claude account "nobody@example\.com"/);
  assert.deepEqual(stored(), { claude: "claude-new@example.com.json" });

  const cleared = run(home, ["accounts", "primary", "claude", "none"]);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(stored(), {});

  // The names `dshproxy login` accepts work here too.
  fs.writeFileSync(path.join(home, "auth", "codex-user@example.com.json"), JSON.stringify({ type: "codex", email: "user@example.com", access_token: "not-a-real-token" }));
  const alias = run(home, ["accounts", "primary", "chatgpt", "user@example.com"]);
  assert.equal(alias.status, 0, alias.stderr);
  assert.deepEqual(stored(), { codex: "codex-user@example.com.json" });
});
