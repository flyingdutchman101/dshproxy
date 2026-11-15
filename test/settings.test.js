const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const settings = require("../src/settings");

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshgate-settings-"));
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
