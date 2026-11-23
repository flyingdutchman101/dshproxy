require("./support/keychain"); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const YAML = require("yaml");

// The video entries the user switched on reach the DeepSeek Harness profile
// through the same commands as the chat models. Everything here works in
// throwaway folders; the defaults of this process point at two more, which
// must stay empty.
const guards = ["DSH_HOME", "DSHPROXY_HOME"].map((name) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-picker-callers-guard-"));
  process.env[name] = folder;
  return folder;
});
test.after(() => {
  try {
    for (const folder of guards) assert.deepEqual(fs.readdirSync(folder), []);
  } finally {
    for (const folder of guards) fs.rmSync(folder, { recursive: true, force: true });
  }
});

const app = require("../src/app");
const video = require("../src/video/settings");

const CLI = path.join(__dirname, "..", "bin", "dshproxy.js");
const SEEDANCE = { model: "seedance-2.5", resolution: "720p", route: "krea" };
const WAN = { model: "wan-3.0", resolution: "1080p", route: "videorouter" };

// A data folder and a DeepSeek Harness home with one empty profile.
function box(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-picker-callers-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const data = path.join(base, "data");
  const harness = path.join(base, "harness");
  fs.mkdirSync(data);
  fs.mkdirSync(path.join(harness, "profiles", "desktop"), { recursive: true });
  return { data, harness, patch: path.join(harness, "profiles", "desktop", "cordis.patch.yml") };
}

// Runs the real CLI in its own process on those two folders.
function run(found, args, input = "") {
  return spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, DSHPROXY_HOME: found.data, DSH_HOME: found.harness }
  });
}

const providers = (found) => YAML.parse(fs.readFileSync(found.patch, "utf8")).find((item) => item.id === "llm-pi-ai").config.providers;

test("a snapshot lists the video entries that are switched on, apart from the chat models", { skip: process.platform === "darwin" ? "macOS: video comes with stage B of 0014 (docs/work/0014-macos-port); until then test/not-yet-darwin.test.js" : false }, async (t) => {
  const found = box(t);
  assert.deepEqual((await app.snapshot(found.data)).video, []);

  await video.setEntry(found.data, SEEDANCE, true);
  await video.setEntry(found.data, WAN, true);
  const state = await app.snapshot(found.data);
  assert.deepEqual(state.video.map((entry) => [entry.id, entry.name, entry.api]).sort(), [
    ["seedance-2.5/720p/krea", "Seedance 2.5 - 720p - Krea", "video"],
    ["wan-3.0/1080p/videorouter", "Wan 3.0 - 1080p - VideoRouter", "video"]
  ]);
  assert.equal(state.videoError, null);
  // Lanes, `dshproxy models` and the account lookups read `models`: no video entry is in it.
  assert.deepEqual(state.models.filter((model) => model.api === "video"), []);
  assert.deepEqual(app.profileModels(state), [...state.models, ...state.video]);
});

test("video settings that cannot be read leave the chat models alone and offer no video entry", { skip: process.platform === "darwin" ? "macOS: video comes with stage B of 0014 (docs/work/0014-macos-port); until then test/not-yet-darwin.test.js" : false }, async (t) => {
  const found = box(t);
  fs.writeFileSync(path.join(found.data, "video-settings.json"), "{ not json");
  const state = await app.snapshot(found.data);
  assert.deepEqual(state.video, []);
  assert.match(state.videoError, /video-settings\.json is not valid JSON/);
  assert.deepEqual(app.profileModels(state), state.models);
});

test("dsh apply writes the entries that are switched on, verify compares against them, and switching the last one off takes the route out", { skip: process.platform === "darwin" ? "macOS: video comes with stage B of 0014 (docs/work/0014-macos-port); until then test/not-yet-darwin.test.js" : false }, (t) => {
  const found = box(t);
  const key = run(found, ["key", "set", "deepseek"], "sk-test-key-for-the-picker-callers-0123456789\n");
  assert.equal(key.status, 0, key.stderr);

  // No entry on: the paid route is not written.
  let applied = run(found, ["dsh", "apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(providers(found)["dshproxy-video"], undefined);
  assert.ok(providers(found)["dshproxy-lanes"], "the chat routes are written");

  // One entry switched on: verify asks for the route before apply has written it.
  assert.equal(run(found, ["video", "entries", "set", "seedance-2.5", "720p", "krea", "on"]).status, 0);
  let verified = run(found, ["dsh", "verify"]);
  assert.equal(verified.status, 1, verified.stdout);
  assert.match(verified.stdout, /route dshproxy-video is missing \(it should list seedance-2\.5\/720p\/krea\)/);

  // A dry run says so and writes nothing.
  const before = fs.readFileSync(found.patch, "utf8");
  const dry = run(found, ["dsh", "apply", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dshproxy-video/);
  assert.equal(fs.readFileSync(found.patch, "utf8"), before);

  applied = run(found, ["dsh", "apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  const route = providers(found)["dshproxy-video"];
  assert.equal(route.baseURL, "http://127.0.0.1:8417/dshproxy/video");
  assert.equal(route.retryPolicy.maxRetries, 0);
  assert.deepEqual(route.models.map((entry) => [entry.id, entry.name]), [["seedance-2.5/720p/krea", "Seedance 2.5 - 720p - Krea"]]);
  verified = run(found, ["dsh", "verify"]);
  assert.doesNotMatch(verified.stdout, /dshproxy-video/, "nothing about the video route is wrong any more");

  // A second entry: verify names exactly what is missing.
  assert.equal(run(found, ["video", "entries", "set", "wan-3.0", "1080p", "videorouter", "on"]).status, 0);
  verified = run(found, ["dsh", "verify"]);
  assert.match(verified.stdout, /dshproxy-video does not list wan-3\.0\/1080p\/videorouter/);

  // Both off: verify reports the route as left over, and apply removes it and only it.
  assert.equal(run(found, ["video", "entries", "set", "seedance-2.5", "720p", "krea", "off"]).status, 0);
  assert.equal(run(found, ["video", "entries", "set", "wan-3.0", "1080p", "videorouter", "off"]).status, 0);
  verified = run(found, ["dsh", "verify"]);
  assert.match(verified.stdout, /dshproxy-video is in this profile with seedance-2\.5\/720p\/krea, but no video entry is offered/);
  applied = run(found, ["dsh", "apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(providers(found)["dshproxy-video"], undefined);
  assert.ok(providers(found)["dshproxy-lanes"]);
});
