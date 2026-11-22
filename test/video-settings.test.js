'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const video = require('../src/video/settings');

// Every test works in its own throwaway folder. No test names the real data
// folder, and none writes anywhere without passing its folder explicitly.
function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-video-settings-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const off = { enabled: false, route: null };
const allOff = { models: { 'seedance-2.5': off, 'seedance-2.0': off, 'minimax-h3': off, 'wan-3.0': off } };
const withModels = (changes) => ({ models: { ...allOff.models, ...changes } });

// Written out by hand from the catalog and the `video` command, not computed:
// the priced API routes per model, plus the Krea workspace route for each.
const allowedRoutes = {
  'seedance-2.5': ['videorouter', 'kovapi', 'krea'],
  'seedance-2.0': ['videorouter', 'kovapi', 'krea'],
  'minimax-h3': ['kovapi', 'callirra', 'krea'],
  'wan-3.0': ['videorouter', 'videorouter-replicate', 'kovapi', 'krea']
};
const everyRoute = ['videorouter', 'videorouter-replicate', 'kovapi', 'callirra', 'krea'];

// A refused change must leave the data folder exactly as it was.
function snapshot(home) {
  return fs.existsSync(home) ? fs.readdirSync(home).sort().map((name) => [name, fs.readFileSync(path.join(home, name), 'utf8')]) : null;
}
async function refused(home, config, pattern) {
  const before = snapshot(home);
  await assert.rejects(video.write(home, config), pattern);
  assert.deepEqual(snapshot(home), before);
}

test('nothing saved: every catalog model is disabled with no route, and reading creates nothing', async (t) => {
  const home = tempHome(t);
  const state = await video.read(home);
  assert.deepEqual(state, allOff);
  assert.deepEqual(Object.keys(state.models), ['seedance-2.5', 'seedance-2.0', 'minimax-h3', 'wan-3.0']);
  assert.deepEqual(fs.readdirSync(home), []);

  const missing = path.join(home, 'not-created-yet');
  assert.deepEqual(await video.read(missing), allOff);
  assert.equal(fs.existsSync(missing), false);
});

test('the settings live in their own file inside the data folder', (t) => {
  const home = tempHome(t);
  assert.equal(video.file(home), path.join(home, 'video-settings.json'));
});

test('an enabled model and its route are saved, returned and read back', async (t) => {
  const home = tempHome(t);
  const expected = withModels({ 'wan-3.0': { enabled: true, route: 'videorouter-replicate' } });
  assert.deepEqual(await video.write(home, { models: { 'wan-3.0': { enabled: true, route: 'videorouter-replicate' } } }), expected);
  assert.deepEqual(await video.read(home), expected);
  // What is on disk is exactly the state, and saving leaves no other file behind.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'video-settings.json'), 'utf8')), expected);
  assert.deepEqual(fs.readdirSync(home), ['video-settings.json']);
});

test('the data folder is created on the first save', async (t) => {
  const home = path.join(tempHome(t), 'fresh', 'home');
  await video.write(home, { models: { 'minimax-h3': { route: 'callirra' } } });
  assert.deepEqual(await video.read(home), withModels({ 'minimax-h3': { enabled: false, route: 'callirra' } }));
});

test('a change touches only the fields it names', async (t) => {
  const home = tempHome(t);
  await video.write(home, { models: { 'wan-3.0': { enabled: true, route: 'kovapi' }, 'minimax-h3': { enabled: true, route: 'callirra' } } });

  // Only a route: the model stays enabled, the other model is untouched.
  await video.write(home, { models: { 'wan-3.0': { route: 'videorouter' } } });
  assert.deepEqual(await video.read(home), withModels({ 'wan-3.0': { enabled: true, route: 'videorouter' }, 'minimax-h3': { enabled: true, route: 'callirra' } }));

  // Only the switch: the chosen route is kept for when it is enabled again.
  await video.write(home, { models: { 'minimax-h3': { enabled: false } } });
  assert.deepEqual(await video.read(home), withModels({ 'wan-3.0': { enabled: true, route: 'videorouter' }, 'minimax-h3': { enabled: false, route: 'callirra' } }));

  // A route can be cleared, and an empty change is not a change.
  await video.write(home, { models: { 'minimax-h3': { route: null }, 'wan-3.0': {} } });
  assert.deepEqual(await video.read(home), withModels({ 'wan-3.0': { enabled: true, route: 'videorouter' } }));
  await video.write(home, { models: {} });
  assert.deepEqual(await video.read(home), withModels({ 'wan-3.0': { enabled: true, route: 'videorouter' } }));
});

test('a model holds one route: choosing another replaces it', async (t) => {
  const home = tempHome(t);
  await video.write(home, { models: { 'seedance-2.5': { enabled: true, route: 'videorouter' } } });
  await video.write(home, { models: { 'seedance-2.5': { route: 'kovapi' } } });
  const state = await video.read(home);
  assert.equal(state.models['seedance-2.5'].route, 'kovapi');
  assert.doesNotMatch(fs.readFileSync(video.file(home), 'utf8'), /videorouter/);
});

test('changes started together are all kept', async (t) => {
  const home = tempHome(t);
  await Promise.all([
    video.write(home, { models: { 'seedance-2.5': { enabled: true } } }),
    video.write(home, { models: { 'seedance-2.0': { route: 'kovapi' } } }),
    video.write(home, { models: { 'minimax-h3': { enabled: true, route: 'kovapi' } } }),
    video.write(home, { models: { 'wan-3.0': { route: 'videorouter' } } }),
    video.write(home, { models: { 'wan-3.0': { enabled: true } } })
  ]);
  assert.deepEqual(await video.read(home), { models: {
    'seedance-2.5': { enabled: true, route: null },
    'seedance-2.0': { enabled: false, route: 'kovapi' },
    'minimax-h3': { enabled: true, route: 'kovapi' },
    'wan-3.0': { enabled: true, route: 'videorouter' }
  } });
  assert.deepEqual(fs.readdirSync(home), ['video-settings.json']);
});

test('what read returns can be written back unchanged', async (t) => {
  const home = tempHome(t);
  await video.write(home, { models: { 'seedance-2.0': { enabled: true, route: 'kovapi' }, 'wan-3.0': { enabled: true } } });
  const before = await video.read(home);
  const text = fs.readFileSync(video.file(home), 'utf8');
  assert.deepEqual(await video.write(home, before), before);
  assert.equal(fs.readFileSync(video.file(home), 'utf8'), text);
  // Changing a returned object does not change what is saved.
  before.models['wan-3.0'].route = 'kovapi';
  assert.equal((await video.read(home)).models['wan-3.0'].route, null);
});

test('chat settings, keys and every other file in the data folder are left exactly as they were', async (t) => {
  const home = tempHome(t);
  const others = {
    'settings.json': `${JSON.stringify({ port: 9100, backendPort: 9101, lanes: { main: ['gpt-6-astra'] }, providers: { deepseek: { region: 'international', keyEnc: 'ZW5j' } }, primary: { claude: 'claude-a.json' }, somethingNewer: { kept: true } }, null, 2)}\n`,
    'models.json': '{"served":["gpt-6-astra"]}',
    'master.key': 'synthetic-not-a-key',
    'control.token': 'synthetic-not-a-token'
  };
  for (const [name, text] of Object.entries(others)) fs.writeFileSync(path.join(home, name), text);
  fs.mkdirSync(path.join(home, 'auth'));
  fs.writeFileSync(path.join(home, 'auth', 'claude-a.json'), '{"synthetic":true}');

  await video.write(home, { models: { 'wan-3.0': { enabled: true, route: 'videorouter' } } });
  await video.write(home, { models: { 'wan-3.0': { enabled: false } } });

  for (const [name, text] of Object.entries(others)) assert.equal(fs.readFileSync(path.join(home, name), 'utf8'), text, name);
  assert.equal(fs.readFileSync(path.join(home, 'auth', 'claude-a.json'), 'utf8'), '{"synthetic":true}');
  assert.deepEqual(fs.readdirSync(home).sort(), ['auth', 'control.token', 'master.key', 'models.json', 'settings.json', 'video-settings.json']);
});

test('saving the chat settings does not lose the video settings', async (t) => {
  const home = tempHome(t);
  const chat = require('../src/settings');
  chat.save({ port: 9100 }, home);
  const expected = await video.write(home, { models: { 'seedance-2.0': { enabled: true, route: 'videorouter' } } });
  // Every chat settings change in the app is this load-then-save.
  chat.save({ ...chat.load(home), cooldownMinutes: 20 }, home);
  assert.deepEqual(await video.read(home), expected);
  assert.equal(chat.load(home).port, 9100);
});

// ------------------------------- fail closed -------------------------------

test('each model accepts exactly its own routes and refuses every other pairing', async (t) => {
  for (const [model, allowed] of Object.entries(allowedRoutes)) {
    for (const route of everyRoute) {
      const home = tempHome(t);
      if (allowed.includes(route)) {
        await video.write(home, { models: { [model]: { enabled: true, route } } });
        assert.deepEqual((await video.read(home)).models[model], { enabled: true, route }, `${model} ${route}`);
      } else {
        await refused(home, { models: { [model]: { enabled: true, route } } }, /route/i);
        assert.deepEqual(await video.read(home), allOff, `${model} ${route}`);
      }
    }
  }
});

test('a route that is not a known route name is refused', async (t) => {
  const home = tempHome(t);
  await video.write(home, { models: { 'wan-3.0': { enabled: true, route: 'kovapi' } } });
  for (const route of ['', 'Krea', ' videorouter', 'videorouter ', 'videorouter,kovapi', 'toString', 'constructor', '__proto__', 0, 1, true, false, undefined, [], ['videorouter'], {}, { route: 'videorouter' }]) {
    await refused(home, { models: { 'wan-3.0': { route } } }, /route/i);
  }
  assert.deepEqual(await video.read(home), withModels({ 'wan-3.0': { enabled: true, route: 'kovapi' } }));
});

test('a model the catalog does not list is refused', async (t) => {
  const home = tempHome(t);
  for (const model of ['wan-3.0-prime', 'WAN-3.0', ' wan-3.0', '', 'krea', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    await refused(home, { models: { [model]: { enabled: true, route: 'videorouter' } } }, /Unknown video model/);
  }
  // Also as JSON would deliver it.
  await refused(home, JSON.parse('{"models":{"__proto__":{"enabled":true,"route":"videorouter"}}}'), /Unknown video model/);
  assert.equal(fs.existsSync(video.file(home)), false);
});

test('the switch takes true or false and nothing else', async (t) => {
  const home = tempHome(t);
  for (const enabled of ['true', 'false', 'yes', 1, 0, null, undefined, [], {}]) {
    await refused(home, { models: { 'seedance-2.0': { enabled, route: 'kovapi' } } }, /seedance-2\.0/);
  }
  assert.deepEqual(await video.read(home), allOff);
});

test('a change may carry only the switch and the route: credentials and other fields are refused and never stored', async (t) => {
  const home = tempHome(t);
  await video.write(home, { models: { 'minimax-h3': { enabled: true, route: 'callirra' } } });
  const secret = 'synthetic-SECRET-9f2c';
  const attempts = [
    { models: { 'minimax-h3': { enabled: true, route: 'callirra', apiKey: secret } } },
    { models: { 'minimax-h3': { token: secret } } },
    { models: { 'minimax-h3': { [secret]: true } } },
    { models: { 'minimax-h3': { route: secret } } },
    { models: { 'minimax-h3': { enabled: true, routes: ['kovapi', 'callirra'] } } },
    { models: { [secret]: { enabled: true } } },
    { models: {}, apiKey: secret },
    { models: {}, [secret]: true }
  ];
  for (const config of attempts) {
    await refused(home, config, (error) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    });
  }
  assert.doesNotMatch(fs.readFileSync(video.file(home), 'utf8'), /SECRET|apiKey|token/);
  assert.deepEqual(await video.read(home), withModels({ 'minimax-h3': { enabled: true, route: 'callirra' } }));
});

test('a change that is not shaped like one is refused', async (t) => {
  const home = tempHome(t);
  class Lookalike { constructor() { this.models = {}; } }
  for (const config of [undefined, null, 'wan-3.0', 7, true, [], [{ models: {} }], {}, { models: null }, { models: [] }, { models: 'wan-3.0' }, { enabled: ['wan-3.0'] }, new Lookalike(),
    { models: { 'wan-3.0': null } }, { models: { 'wan-3.0': 'videorouter' } }, { models: { 'wan-3.0': true } }, { models: { 'wan-3.0': ['videorouter'] } }, { models: { 'wan-3.0': new Lookalike() } }]) {
    await refused(home, config, /video/i);
  }
  assert.deepEqual(fs.readdirSync(home), []);
});

test('one refused part refuses the whole change', async (t) => {
  const home = tempHome(t);
  await video.write(home, { models: { 'seedance-2.5': { enabled: true, route: 'kovapi' } } });
  await refused(home, { models: { 'seedance-2.5': { enabled: false }, 'seedance-2.0': { enabled: true, route: 'videorouter' }, 'wan-3.0': { enabled: true, route: 'callirra' } } }, /route/i);
  await refused(home, { models: { 'seedance-2.0': { enabled: true, route: 'videorouter' }, 'wan-3.1': { enabled: true } } }, /Unknown video model/);
  assert.deepEqual(await video.read(home), withModels({ 'seedance-2.5': { enabled: true, route: 'kovapi' } }));
});

test('the data folder must be named as text, so a change cannot be mistaken for it', async (t) => {
  for (const home of ['', null, 7, {}, [], { models: {} }]) {
    await assert.rejects(video.write(home, { models: {} }), /data folder/);
    await assert.rejects(video.read(home), /data folder/);
    assert.throws(() => video.file(home), /data folder/);
  }
});

// ------------------------------- the saved file -------------------------------

for (const [name, text] of [['cut off', '{"models": {"wan-3.0": {"enabled": true'], ['a list', '[1, 2]'], ['empty', ''], ['null', 'null'], ['text', '"wan-3.0"']]) {
  test(`a saved file that is ${name} is an error for reading and for changing, and is left in place`, async (t) => {
    const home = tempHome(t);
    fs.writeFileSync(video.file(home), text);
    await assert.rejects(video.read(home), /video-settings\.json/);
    await assert.rejects(video.offered(home), /video-settings\.json/);
    await refused(home, { models: { 'wan-3.0': { enabled: true, route: 'videorouter' } } }, /video-settings\.json/);
    assert.equal(fs.readFileSync(video.file(home), 'utf8'), text);
  });
}

test('the error for a damaged file names the file and repeats nothing from inside it', async (t) => {
  const home = tempHome(t);
  fs.writeFileSync(video.file(home), '{"models": {"wan-3.0": {"apiKey": "synthetic-LEAK-0"');
  for (const attempt of [video.read(home), video.offered(home), video.write(home, { models: {} })]) {
    await assert.rejects(attempt, (error) => {
      assert.match(error.message, /video-settings\.json/);
      assert.doesNotMatch(error.message, /LEAK|apiKey|wan-3\.0/);
      return true;
    });
  }
});

test('a saved file that cannot be read is an error and is not replaced', async (t) => {
  const home = tempHome(t);
  fs.mkdirSync(video.file(home));
  await assert.rejects(video.read(home), /video-settings\.json/);
  await assert.rejects(video.write(home, { models: { 'wan-3.0': { enabled: true } } }), /video-settings\.json/);
  assert.ok(fs.statSync(video.file(home)).isDirectory());
  assert.deepEqual(fs.readdirSync(home), ['video-settings.json']);
});

test('a saved entry that is not exactly a valid one counts as disabled with no route', async (t) => {
  const home = tempHome(t);
  fs.writeFileSync(video.file(home), JSON.stringify({ models: {
    'seedance-2.5': { enabled: true, route: 'callirra' },
    'seedance-2.0': { enabled: 'yes', route: 'kovapi' },
    'minimax-h3': { enabled: true, route: 'callirra', apiKey: 'synthetic-LEAK-1' },
    'wan-3.0': ['videorouter'],
    'retired-model': { enabled: true, route: 'videorouter' }
  } }));
  assert.deepEqual(await video.read(home), allOff);
  assert.deepEqual(await video.offered(home), []);
});

test('saved parts of the wrong shape count as nothing saved', async (t) => {
  for (const saved of [{}, { models: null }, { models: [] }, { models: 'wan-3.0' }, { models: { 'wan-3.0': null } }, { enabled: ['wan-3.0'] }]) {
    const home = tempHome(t);
    fs.writeFileSync(video.file(home), JSON.stringify(saved));
    assert.deepEqual(await video.read(home), allOff);
  }
});

test('valid saved entries are kept beside ignored ones, and the next save drops everything else from the file', async (t) => {
  const home = tempHome(t);
  fs.writeFileSync(video.file(home), `{
    "token": "synthetic-LEAK-2",
    "models": {
      "__proto__": { "enabled": true, "route": "videorouter" },
      "wan-3.0": { "enabled": true, "route": "krea" },
      "seedance-2.0": { "route": "kovapi" },
      "minimax-h3": { "enabled": true, "route": "videorouter", "note": "synthetic-LEAK-3" },
      "retired-model": { "enabled": true, "route": "videorouter" }
    }
  }`);
  const kept = withModels({ 'wan-3.0': { enabled: true, route: 'krea' }, 'seedance-2.0': { enabled: false, route: 'kovapi' } });
  const state = await video.read(home);
  assert.deepEqual(state, kept);
  assert.doesNotMatch(JSON.stringify(state), /LEAK|retired|token/);
  assert.equal({}.enabled, undefined);

  await video.write(home, { models: {} });
  const text = fs.readFileSync(video.file(home), 'utf8');
  assert.doesNotMatch(text, /LEAK|retired|token|note|__proto__/);
  assert.deepEqual(JSON.parse(text), kept);
});

// ------------------------------- what consumers use -------------------------------

test('only a model that is enabled and has a route is offered', async (t) => {
  const home = tempHome(t);
  assert.deepEqual(await video.offered(home), []);
  await video.write(home, { models: {
    'wan-3.0': { enabled: true, route: 'krea' },
    'seedance-2.5': { enabled: true },
    'seedance-2.0': { enabled: false, route: 'kovapi' },
    'minimax-h3': { enabled: true, route: 'callirra' }
  } });
  assert.deepEqual(await video.offered(home), [{ model: 'minimax-h3', route: 'callirra' }, { model: 'wan-3.0', route: 'krea' }]);
  await video.write(home, { models: { 'wan-3.0': { route: null }, 'seedance-2.5': { route: 'videorouter' } } });
  assert.deepEqual(await video.offered(home), [{ model: 'seedance-2.5', route: 'videorouter' }, { model: 'minimax-h3', route: 'callirra' }]);
});

// A catalog route carries a dated published price, which is not proof that the
// route works; nothing here may call a route verified.
test('the routes a model can take are listed: catalog routes as published estimates, the workspace route as unverified', () => {
  for (const [model, allowed] of Object.entries(allowedRoutes)) {
    assert.deepEqual(video.routes(model), allowed.map((route) => ({ route, compatibility: route === 'krea' ? 'unverified' : 'published-estimate' })), model);
  }
  assert.deepEqual(video.routes('minimax-h3'), [
    { route: 'kovapi', compatibility: 'published-estimate' },
    { route: 'callirra', compatibility: 'published-estimate' },
    { route: 'krea', compatibility: 'unverified' }
  ]);
  for (const model of ['wan-3.0-prime', 'constructor', '__proto__', '', undefined, null]) assert.throws(() => video.routes(model), /Unknown video model/);
});

// ------------------------------- the default data folder -------------------------------

// Run in a child process whose profile folder is a throwaway one, so that not
// even a faulty build could reach the real data folder from here.
function inChild(t, withDataFolder) {
  const profile = tempHome(t);
  const dataFolder = tempHome(t);
  const env = { USERPROFILE: profile, HOME: profile };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (withDataFolder) env.DSHPROXY_HOME = dataFolder;
  const script = `
    const video = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'video', 'settings.js'))});
    (async () => {
      const written = await video.write(undefined, { models: { 'wan-3.0': { enabled: true, route: 'kovapi' } } });
      process.stdout.write(JSON.stringify({ file: video.file(), written, read: await video.read(), offered: await video.offered() }));
    })().catch((error) => { process.stderr.write(String(error)); process.exit(1); });`;
  const run = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  return { profile, dataFolder, result: JSON.parse(run.stdout) };
}

test('with no folder named, DSHPROXY_HOME is the data folder', (t) => {
  const { profile, dataFolder, result } = inChild(t, true);
  const expected = withModels({ 'wan-3.0': { enabled: true, route: 'kovapi' } });
  assert.equal(result.file, path.join(dataFolder, 'video-settings.json'));
  assert.deepEqual(result.written, expected);
  assert.deepEqual(result.read, expected);
  assert.deepEqual(result.offered, [{ model: 'wan-3.0', route: 'kovapi' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataFolder, 'video-settings.json'), 'utf8')), expected);
  assert.deepEqual(fs.readdirSync(profile), []);
});

test('with no folder named and no DSHPROXY_HOME, it is .dshproxy in the profile folder', (t) => {
  const { profile, dataFolder, result } = inChild(t, false);
  assert.equal(result.file, path.join(profile, '.dshproxy', 'video-settings.json'));
  assert.deepEqual(result.read, withModels({ 'wan-3.0': { enabled: true, route: 'kovapi' } }));
  assert.deepEqual(fs.readdirSync(path.join(profile, '.dshproxy')), ['video-settings.json']);
  assert.deepEqual(fs.readdirSync(dataFolder), []);
});

// ------------------------------- any sequence of changes -------------------------------

// A small fixed-seed generator: the same sequences on every run.
function generator(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  return { chance: (p) => next() < p, pick: (list) => list[Math.floor(next() * list.length)] };
}

const refusedParts = [
  { enabled: 'true' }, { enabled: 1 }, { enabled: null }, { route: 'krea ' }, { route: 'unlisted' }, { route: 7 }, { route: ['kovapi'] },
  { apiKey: 'synthetic-SECRET-seq' }, { enabled: true, token: 'synthetic-SECRET-seq' }, null, 'krea', []
];

for (const seed of [1, 2, 3]) {
  test(`after any sequence of accepted and refused changes the saved state is exactly the accepted ones (seed ${seed})`, async (t) => {
    const home = tempHome(t);
    const chat = require('../src/settings');
    const random = generator(seed);
    const names = Object.keys(allowedRoutes);
    const vocabulary = new Set([...names, ...everyRoute, 'models', 'enabled', 'route']);
    // The expected state, kept here by hand: a plain record per model.
    const expected = Object.fromEntries(names.map((model) => [model, { enabled: false, route: null }]));

    for (let step = 0; step < 120; step += 1) {
      const change = {};
      let valid = true;
      for (const model of names.filter(() => random.chance(0.4))) {
        const part = {};
        if (random.chance(0.6)) part.enabled = random.chance(0.5);
        if (random.chance(0.6)) part.route = random.chance(0.2) ? null : random.pick(everyRoute);
        if (part.route !== undefined && part.route !== null && !allowedRoutes[model].includes(part.route)) valid = false;
        change[model] = part;
      }
      if (random.chance(0.15)) {
        change[random.chance(0.3) ? 'unlisted-model' : random.pick(names)] = random.pick(refusedParts);
        valid = false;
      }

      if (valid) {
        for (const [model, part] of Object.entries(change)) Object.assign(expected[model], part);
        assert.deepEqual(await video.write(home, { models: change }), { models: expected }, `step ${step}`);
      } else {
        await refused(home, { models: change }, Error);
      }
      if (random.chance(0.1)) chat.save({ ...chat.load(home), cooldownMinutes: 5 + (step % 20) }, home);

      assert.deepEqual(await video.read(home), { models: expected }, `step ${step}`);
      assert.deepEqual(await video.offered(home), names.filter((model) => expected[model].enabled && expected[model].route).map((model) => ({ model, route: expected[model].route })), `step ${step}`);
      if (fs.existsSync(video.file(home))) {
        // Nothing but model names, route names and the two field names is ever on disk.
        const words = fs.readFileSync(video.file(home), 'utf8').match(/"[^"]*"/g).map((word) => word.slice(1, -1));
        assert.deepEqual(words.filter((word) => !vocabulary.has(word)), [], `step ${step}`);
      }
    }
    assert.ok(fs.readdirSync(home).every((name) => ['settings.json', 'video-settings.json'].includes(name)));
  });
}
