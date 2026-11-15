const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const CLI = path.join(__dirname, "..", "bin", "dshgate.js");

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshgate-cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// Runs the real CLI in its own process, with its data in a temporary folder.
function run(home, args, input = "") {
  return spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, DSHGATE_HOME: home, DSH_HOME: path.join(home, "no-deepseek-harness") }
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
