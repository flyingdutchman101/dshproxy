const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const settings = require("../src/settings");

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-settings-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test("a missing settings file gives the defaults", (t) => {
  const loaded = settings.load(tempHome(t));
  assert.equal(loaded.port, 8417);
  assert.equal(loaded.backendPort, 8418);
  assert.deepEqual(loaded.providers, {});
});

for (const [name, text] of [["cut off", '{"port": 9000, "providers": {"deepseek": {"keyEnc": "abc"'], ["not an object", "[1, 2]"], ["empty", ""]]) {
  test(`a settings file that is ${name} is an error and is left in place`, (t) => {
    const home = tempHome(t);
    const file = path.join(home, "settings.json");
    fs.writeFileSync(file, text);
    assert.throws(() => settings.load(home), /settings\.json/);
    assert.equal(fs.readFileSync(file, "utf8"), text);
  });
}

test("saved settings are read back, and saving leaves no other file behind", (t) => {
  const home = tempHome(t);
  settings.save({ port: 9100, backendPort: 9101, lanes: { main: ["gpt-6-astra"] }, providers: { deepseek: { region: "international", keyEnc: "ZW5j" } } }, home);
  settings.save({ ...settings.load(home), cooldownMinutes: 20 }, home);
  const loaded = settings.load(home);
  assert.equal(loaded.port, 9100);
  assert.equal(loaded.cooldownMinutes, 20);
  assert.deepEqual(loaded.lanes, { main: ["gpt-6-astra"] });
  assert.deepEqual(loaded.providers, { deepseek: { region: "international", keyEnc: "ZW5j" } });
  assert.deepEqual(fs.readdirSync(home), ["settings.json"]);
});

// The data folder was ~/.dshgate before the rename.
function oldHome(t) {
  const parent = tempHome(t);
  const old = path.join(parent, ".dshgate");
  fs.mkdirSync(path.join(old, "auth"), { recursive: true });
  fs.writeFileSync(path.join(old, "settings.json"), '{"port": 9100}');
  fs.writeFileSync(path.join(old, "auth", "claude-a.json"), "{}");
  fs.writeFileSync(path.join(old, "dshgate.log"), "old log\n");
  return { parent, old, home: path.join(parent, ".dshproxy") };
}

test("the old data folder is moved to the new name once, with sign-ins and settings", (t) => {
  const { old, home } = oldHome(t);
  assert.deepEqual(settings.migrateHome(home, old), { moved: true, from: old });
  assert.equal(fs.existsSync(old), false);
  assert.equal(settings.load(home).port, 9100);
  assert.ok(fs.existsSync(path.join(home, "auth", "claude-a.json")));
  assert.equal(fs.readFileSync(path.join(home, "dshproxy.log"), "utf8"), "old log\n");
  assert.deepEqual(settings.migrateHome(home, old), { moved: false });
});

test("an existing new data folder is never replaced by the old one", (t) => {
  const { old, home } = oldHome(t);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "settings.json"), '{"port": 9200}');
  assert.deepEqual(settings.migrateHome(home, old), { moved: false });
  assert.equal(settings.load(home).port, 9200);
  assert.ok(fs.existsSync(path.join(old, "settings.json")));
});
