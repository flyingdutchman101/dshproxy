'use strict';
require("./support/keychain"); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
// Entries that can be switched on: one model at one resolution on one route.
// They live in video-settings.json beside the per-model settings. Every test
// works in its own throwaway folder and nothing here uses a network.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const guard = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-video-entries-guard-'));
process.env.DSHPROXY_HOME = guard;
globalThis.fetch = () => { throw new Error('network is forbidden in this test'); };
after(() => {
  try { assert.deepEqual(fs.readdirSync(guard), []); } finally { fs.rmSync(guard, { recursive: true, force: true }); }
});

const video = require('../src/video/settings');
const catalog = require('../src/video/catalog');
const { run: command } = require('../src/video/command');

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-video-entries-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const file = (home) => path.join(home, 'video-settings.json');
const onDisk = (home) => JSON.parse(fs.readFileSync(file(home), 'utf8'));
const snapshot = (home) => (fs.existsSync(home) ? fs.readdirSync(home).sort().map((name) => [name, fs.readFileSync(path.join(home, name), 'utf8')]) : null);
const off = { enabled: false, route: null };
const allOff = { models: { 'seedance-2.5': off, 'seedance-2.0': off, 'minimax-h3': off, 'wan-3.0': off, 'flux-3': off, 'seedance-2.0-fast': off, 'seedance-2.0-mini': off, 'veo-3.1': off, 'veo-3.1-fast': off, aurora: off, 'kling-v3-standard': off } };
const names = (list) => list.map((entry) => `${entry.model}/${entry.resolution}/${entry.route}`);
const switchedOn = async (home) => names((await video.entries(home)).filter((entry) => entry.on));

const SEEDANCE = { model: 'seedance-2.5', resolution: '720p', route: 'krea' };
const WAN = { model: 'wan-3.0', resolution: '1080p', route: 'videorouter-replicate' };
const TIER = { model: 'minimax-h3', resolution: '2K', route: 'krea' };
const FLUX = { model: 'flux-3', resolution: '1080p', route: 'videorouter' };

test('nothing saved: every entry of the catalog is listed and off, and reading creates nothing', async (t) => {
  const home = tempHome(t);
  const listed = await video.entries(home);
  assert.equal(listed.length, 62);
  assert.deepEqual(names(listed), names(catalog.entries()));
  assert.ok(listed.every((entry) => entry.on === false));
  assert.deepEqual(listed.map(({ on, ...entry }) => entry), catalog.entries());
  assert.deepEqual(await video.entriesOn(home), []);
  assert.deepEqual(fs.readdirSync(home), []);
  const missing = path.join(home, 'not-created-yet');
  assert.deepEqual(await switchedOn(missing), []);
  assert.equal(fs.existsSync(missing), false);
});

test('an entry switched on is saved, returned and read back, with its picker name', async (t) => {
  const home = tempHome(t);
  const returned = await video.setEntry(home, SEEDANCE, true);
  assert.deepEqual(names(returned.filter((entry) => entry.on)), ['seedance-2.5/720p/krea']);
  assert.equal(returned.length, 62);
  assert.deepEqual(await switchedOn(home), ['seedance-2.5/720p/krea']);
  const [on] = await video.entriesOn(home);
  assert.deepEqual([on.model, on.resolution, on.route, on.label, on.priceBasis], ['seedance-2.5', '720p', 'krea', 'Seedance 2.5 - 720p - Krea', 'live-quote']);
  // On disk: today's settings as they were, and the entry by its three names.
  assert.deepEqual(onDisk(home), { ...allOff, entries: [SEEDANCE] });
  assert.deepEqual(fs.readdirSync(home), ['video-settings.json']);
});

test('entries are switched one at a time, kept in catalog order, and switching one off leaves the others', async (t) => {
  const home = tempHome(t);
  for (const entry of [FLUX, TIER, WAN, SEEDANCE]) await video.setEntry(home, entry, true);
  assert.deepEqual(await switchedOn(home), ['seedance-2.5/720p/krea', 'minimax-h3/2K/krea', 'wan-3.0/1080p/videorouter-replicate', 'flux-3/1080p/videorouter']);
  assert.deepEqual(onDisk(home).entries, [SEEDANCE, TIER, WAN, FLUX]);
  assert.deepEqual((await video.entriesOn(home)).map((entry) => entry.label),
    ['Seedance 2.5 - 720p - Krea', 'MiniMax H3 - 2K - Krea', 'Wan 3.0 - 1080p - VideoRouter (Replicate)', 'Flux 3 - 1080p - VideoRouter']);
  // Switching on twice, or off twice, is the same as once.
  await video.setEntry(home, WAN, true);
  await video.setEntry(home, TIER, false);
  await video.setEntry(home, TIER, false);
  assert.deepEqual(await switchedOn(home), ['seedance-2.5/720p/krea', 'wan-3.0/1080p/videorouter-replicate', 'flux-3/1080p/videorouter']);
  for (const entry of [SEEDANCE, WAN, FLUX]) await video.setEntry(home, entry, false);
  assert.deepEqual(await switchedOn(home), []);
  // With every entry off the file is the one an older DSHProxy wrote.
  assert.deepEqual(onDisk(home), allOff);
});

test('today\'s settings keep their meaning: a model setting and an entry do not touch each other', async (t) => {
  const home = tempHome(t);
  await video.write(home, { models: { 'wan-3.0': { enabled: true, route: 'kovapi' } } });
  await video.setEntry(home, SEEDANCE, true);
  const expected = { models: { ...allOff.models, 'wan-3.0': { enabled: true, route: 'kovapi' } } };
  assert.deepEqual(await video.read(home), expected);
  assert.deepEqual(await video.offered(home), [{ model: 'wan-3.0', route: 'kovapi' }]);
  // An entry of a model that is disabled, on a route other than the model's own, is still its own switch.
  assert.deepEqual(await switchedOn(home), ['seedance-2.5/720p/krea']);
  assert.deepEqual(await video.write(home, { models: { 'seedance-2.5': { enabled: true, route: 'videorouter' } } }),
    { models: { ...expected.models, 'seedance-2.5': { enabled: true, route: 'videorouter' } } });
  assert.deepEqual(await switchedOn(home), ['seedance-2.5/720p/krea']);
  assert.deepEqual(onDisk(home), { models: { ...expected.models, 'seedance-2.5': { enabled: true, route: 'videorouter' } }, entries: [SEEDANCE] });
});

test('an older file without entries reads as all off and keeps its settings', async (t) => {
  const home = tempHome(t);
  fs.writeFileSync(file(home), JSON.stringify({ models: { 'seedance-2.5': off, 'seedance-2.0': off, 'minimax-h3': { enabled: true, route: 'callirra' }, 'wan-3.0': off } }, null, 2));
  const before = snapshot(home);
  assert.deepEqual(await switchedOn(home), []);
  assert.deepEqual(await video.entriesOn(home), []);
  assert.deepEqual((await video.read(home)).models['minimax-h3'], { enabled: true, route: 'callirra' });
  assert.deepEqual(snapshot(home), before);
  await video.setEntry(home, TIER, true);
  assert.deepEqual(onDisk(home), { models: { ...allOff.models, 'minimax-h3': { enabled: true, route: 'callirra' } }, entries: [TIER] });
});

test('a file with an entry that no longer exists is read without failing, and that entry is gone after the next write', async (t) => {
  const gone = [
    { model: 'seedance-2.5', resolution: '768p', route: 'krea' }, { model: 'wan-3.0-prime', resolution: '720p', route: 'krea' }, { model: 'flux-3', resolution: '480p', route: 'videorouter' },
    { model: 'minimax-h3', resolution: '768p', route: 'krea' }, { model: 'wan-3.0', resolution: '720p', route: 'callirra' },
  ];
  const junk = ['wan-3.0/720p/krea', null, 7, true, [], ['wan-3.0', '720p', 'krea'], {}, { model: 'wan-3.0', resolution: '720p' },
    { model: 'wan-3.0', resolution: '720p', route: 'krea', apiKey: 'synthetic-LEAK-1' }, { model: 'wan-3.0', resolution: '720p', route: 'krea', on: true }, { model: 'synthetic-LEAK-2', resolution: '720p', route: 'krea' }];
  for (const write of ['entry', 'model']) {
    const home = tempHome(t);
    fs.writeFileSync(file(home), JSON.stringify({ models: { 'wan-3.0': { enabled: true, route: 'krea' } }, entries: [...gone, WAN, ...junk, SEEDANCE, WAN] }));
    // Read without failing: the two that exist are on, once each, and nothing else is.
    assert.deepEqual(await switchedOn(home), ['seedance-2.5/720p/krea', 'wan-3.0/1080p/videorouter-replicate']);
    assert.deepEqual((await video.read(home)).models['wan-3.0'], { enabled: true, route: 'krea' });
    assert.match(fs.readFileSync(file(home), 'utf8'), /LEAK/);
    if (write === 'entry') await video.setEntry(home, FLUX, true);
    else await video.write(home, { models: { 'flux-3': { enabled: true, route: 'krea' } } });
    assert.deepEqual(onDisk(home).entries, write === 'entry' ? [SEEDANCE, WAN, FLUX] : [SEEDANCE, WAN]);
    assert.doesNotMatch(fs.readFileSync(file(home), 'utf8'), /LEAK|768p|prime|apiKey|480p/);
  }
  // "entries" of another shape altogether counts as none.
  for (const entries of [null, 'wan-3.0', 7, true, {}, { 'wan-3.0': { '720p': { krea: true } } }]) {
    const home = tempHome(t);
    fs.writeFileSync(file(home), JSON.stringify({ models: {}, entries }));
    assert.deepEqual(await switchedOn(home), []);
  }
});

test('only an entry of the catalog can be switched, by its three names and true or false; a refusal writes nothing and repeats nothing', async (t) => {
  const home = tempHome(t);
  await video.setEntry(home, SEEDANCE, true);
  const before = snapshot(home);
  const secret = 'synthetic-SECRET-entry';
  const refuse = async (entry, on, pattern) => {
    await assert.rejects(video.setEntry(home, entry, on), (error) => { assert.match(error.message, pattern); assert.equal(error.message.includes(secret), false); return true; }, JSON.stringify([entry, on]));
    assert.deepEqual(snapshot(home), before);
  };
  await refuse({ ...SEEDANCE, model: 'seedance-3' }, true, /Unknown video model/);
  await refuse({ ...SEEDANCE, model: secret }, true, /Unknown video model/);
  await refuse({ ...SEEDANCE, model: '__proto__' }, true, /Unknown video model/);
  await refuse({ ...SEEDANCE, route: 'callirra' }, true, /route/i);
  await refuse({ ...SEEDANCE, route: secret }, true, /route/i);
  await refuse({ ...SEEDANCE, route: 'constructor' }, true, /route/i);
  // Combinations that are not entries.
  await refuse({ ...SEEDANCE, resolution: '768p' }, true, /not an entry/i);
  await refuse({ ...SEEDANCE, resolution: secret }, true, /not an entry/i);
  await refuse({ ...SEEDANCE, resolution: '720P' }, true, /not an entry/i);
  await refuse({ model: 'flux-3', resolution: '480p', route: 'krea' }, true, /not an entry/i);
  await refuse({ model: 'flux-3', resolution: '480p', route: 'videorouter' }, false, /not an entry/i);
  await refuse({ model: 'seedance-2.0', resolution: '4k', route: 'kovapi' }, true, /not an entry/i);
  // A fixed tier asked for a resolution.
  for (const resolution of ['480p', '720p', '768p', '1080p']) await refuse({ ...TIER, resolution }, true, /fixed tier/i);
  // Anything but exactly the three names, and anything but true or false.
  for (const entry of [undefined, null, 'seedance-2.5/720p/krea', [], ['seedance-2.5', '720p', 'krea'], {}, { model: 'seedance-2.5', route: 'krea' }, { ...SEEDANCE, apiKey: secret }, { ...SEEDANCE, on: true },
    { ...SEEDANCE, resolution: 720 }, { ...SEEDANCE, resolution: null }]) await refuse(entry, true, /entry/i);
  for (const on of [undefined, null, 'on', 'true', 1, 0, {}, secret]) await refuse(SEEDANCE, on, /true or false/);
  assert.deepEqual(await switchedOn(home), ['seedance-2.5/720p/krea']);
});

test('the file holds names and true or false only, whatever is switched', async (t) => {
  const home = tempHome(t);
  const all = catalog.entries();
  const vocabulary = new Set(['models', 'enabled', 'route', 'entries', 'model', 'resolution', ...catalog.models,
    ...all.map((entry) => entry.route), ...all.map((entry) => entry.resolution)]);
  for (let step = 0; step < all.length; step += 3) {
    await video.setEntry(home, { model: all[step].model, resolution: all[step].resolution, route: all[step].route }, true);
    if (step % 2) await video.write(home, { models: { [all[step].model]: { enabled: true } } });
    const text = fs.readFileSync(file(home), 'utf8');
    assert.deepEqual(text.match(/"[^"]*"/g).map((word) => word.slice(1, -1)).filter((word) => !vocabulary.has(word)), [], `step ${step}`);
    // Beside quoted names: true, false, null and punctuation, and no number.
    assert.equal(text.replace(/"[^"]*"/g, '').replace(/true|false|null/g, '').replace(/[\s{}\[\],:]/g, ''), '', `step ${step}`);
  }
  assert.equal((await video.entriesOn(home)).length, Math.ceil(all.length / 3));
});

test('a damaged file is an error for the entries too, and is never replaced unseen', async (t) => {
  const home = tempHome(t);
  fs.writeFileSync(file(home), '{"entries": [{"model": "wan-3.0", "apiKey": "synthetic-LEAK-0"');
  const before = snapshot(home);
  for (const attempt of [() => video.entries(home), () => video.entriesOn(home), () => video.setEntry(home, WAN, true)]) {
    await assert.rejects(attempt(), (error) => { assert.match(error.message, /video-settings\.json/); assert.doesNotMatch(error.message, /LEAK|apiKey/); return true; });
  }
  assert.deepEqual(snapshot(home), before);
});

// ------------------------------- several writers -------------------------------

test('writers at the same moment do not lose each other\'s change: entries and model settings', async (t) => {
  const home = tempHome(t);
  const all = catalog.entries().map(({ model, resolution, route }) => ({ model, resolution, route }));
  await Promise.all([
    ...all.map((entry) => video.setEntry(home, entry, true)),
    video.write(home, { models: { 'wan-3.0': { enabled: true, route: 'krea' } } }),
    video.write(home, { models: { 'flux-3': { enabled: true, route: 'videorouter' } } }),
  ]);
  assert.deepEqual(await switchedOn(home), names(all));
  assert.deepEqual(await video.read(home), { models: { ...allOff.models, 'wan-3.0': { enabled: true, route: 'krea' }, 'flux-3': { enabled: true, route: 'videorouter' } } });
  await Promise.all([...all.filter((_, index) => index % 2).map((entry) => video.setEntry(home, entry, false)), video.write(home, { models: { 'wan-3.0': { enabled: false } } })]);
  assert.deepEqual(await switchedOn(home), names(all.filter((_, index) => index % 2 === 0)));
  assert.deepEqual((await video.read(home)).models['wan-3.0'], { enabled: false, route: 'krea' });
  assert.deepEqual(fs.readdirSync(home), ['video-settings.json']);
});

test('while another command is changing the file, switching an entry waits and then refuses; nothing is changed', async (t) => {
  const home = tempHome(t);
  await video.setEntry(home, SEEDANCE, true);
  const clock = { time: 1_700_000_000_000, slept: 0 };
  fs.writeFileSync(`${file(home)}.lock`, `${JSON.stringify({ id: 'a1b2c3d4e5f6a7b8c9d0e1f2', pid: process.pid, at: clock.time })}\n`);
  const before = snapshot(home);
  const io = { now: () => clock.time, sleep: async (ms) => { clock.slept += ms; clock.time += ms; } };
  await assert.rejects(video.setEntry(home, WAN, true, { io }), { message: `Another DSHProxy command is changing ${file(home)} and did not finish within 10 seconds, so nothing was saved.` });
  assert.equal(clock.slept, 10000);
  assert.deepEqual(snapshot(home), before);
});

function cli(home, args) {
  return new Promise((resolve) => {
    const env = { ...process.env, DSHPROXY_HOME: home };
    for (const name of ['VIDEOROUTER_API_KEY', 'KOVAPI_API_KEY', 'CALLIRRA_API_KEY', 'ELEVENLABS_API_KEY']) delete env[name];
    const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/dshproxy.js'), 'video', ...args], { env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('two installed commands at the same moment both take effect', async (t) => {
  const home = tempHome(t);
  const done = await Promise.all([
    cli(home, ['entries', 'set', 'seedance-2.5', '720p', 'krea', 'on']), cli(home, ['entries', 'set', 'flux-3', '1080p', 'videorouter', 'on']),
    cli(home, ['entries', 'set', 'minimax-h3', '2K', 'krea', 'on']), cli(home, ['settings', 'set', 'wan-3.0', 'kovapi', 'enabled']),
  ]);
  for (const result of done) assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await switchedOn(home), ['seedance-2.5/720p/krea', 'minimax-h3/2K/krea', 'flux-3/1080p/videorouter']);
  assert.deepEqual((await video.read(home)).models['wan-3.0'], { enabled: true, route: 'kovapi' });
  const listed = await cli(home, ['entries']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).entries.filter((entry) => entry.on).map((entry) => entry.label), ['Seedance 2.5 - 720p - Krea', 'MiniMax H3 - 2K - Krea', 'Flux 3 - 1080p - VideoRouter']);
});

// ------------------------------- the command -------------------------------

function session(t) {
  const home = tempHome(t);
  const seen = [];
  const deps = { env: { DSHPROXY_HOME: home }, fetchImpl: async () => { seen.push('fetch'); throw new Error('network is forbidden'); }, workspace: async () => { seen.push('workspace'); throw new Error('the helper is forbidden'); } };
  const exec = async (...args) => { const lines = []; await command(args, (text) => lines.push(text), deps); return JSON.parse(lines.join('\n')); };
  return { home, seen, exec };
}

test('video entries lists every entry with on or off, and video entries set switches one', async (t) => {
  const s = session(t);
  const listed = await s.exec('entries');
  assert.deepEqual(Object.keys(listed), ['entries']);
  assert.equal(listed.entries.length, 62);
  assert.ok(listed.entries.every((entry) => entry.on === false));
  assert.deepEqual(fs.readdirSync(s.home), []);
  const row = listed.entries.find((entry) => entry.label === 'Seedance 2.5 - 1080p - VideoRouter');
  assert.deepEqual([row.model, row.resolution, row.route, row.on, row.priceBasis, row.usdMicros, row.verifiedOn, row.host], ['seedance-2.5', '1080p', 'videorouter', false, 'published', 2272938, '2026-11-22', 'botsmart']);
  const tier = listed.entries.find((entry) => entry.label === 'MiniMax H3 - 2K - Krea');
  assert.deepEqual([tier.fixedTier, tier.priceBasis, tier.reference.computeUnits, tier.reference.recordedOn], [true, 'live-quote', 481.48148148148147, '2026-11-22']);

  const after = await s.exec('entries', 'set', 'seedance-2.5', '1080p', 'videorouter', 'on');
  assert.deepEqual(after.entries.filter((entry) => entry.on).map((entry) => entry.label), ['Seedance 2.5 - 1080p - VideoRouter']);
  await s.exec('entries', 'set', 'minimax-h3', '2K', 'krea', 'on');
  assert.deepEqual((await s.exec('entries')).entries.filter((entry) => entry.on).map((entry) => entry.label), ['Seedance 2.5 - 1080p - VideoRouter', 'MiniMax H3 - 2K - Krea']);
  const off = await s.exec('entries', 'set', 'seedance-2.5', '1080p', 'videorouter', 'off');
  assert.deepEqual(off.entries.filter((entry) => entry.on).map((entry) => entry.label), ['MiniMax H3 - 2K - Krea']);
  assert.deepEqual(s.seen, []);
});

test('video entries set refuses an unknown model, resolution or route, a combination that is not an entry and a fixed tier asked for a resolution', async (t) => {
  const s = session(t);
  await s.exec('entries', 'set', 'wan-3.0', '720p', 'krea', 'on');
  const before = snapshot(s.home);
  for (const [args, pattern] of [
    [['entries', 'set', 'wan-3.0-prime', '720p', 'krea', 'on'], /Unknown video model/],
    [['entries', 'set', 'wan-3.0', '720p', 'callirra', 'on'], /route/i],
    [['entries', 'set', 'wan-3.0', '720p', 'nowhere', 'on'], /route/i],
    [['entries', 'set', 'wan-3.0', '999p', 'krea', 'on'], /not an entry/i],
    [['entries', 'set', 'seedance-2.5', '768p', 'kovapi', 'on'], /not an entry/i],
    [['entries', 'set', 'flux-3', '480p', 'krea', 'off'], /not an entry/i],
    [['entries', 'set', 'minimax-h3', '768p', 'krea', 'on'], /fixed tier/i],
    [['entries', 'set', 'minimax-h3', '1080p', 'krea', 'on'], /fixed tier/i],
    [['entries', 'set', 'wan-3.0', '720p', 'krea', 'enabled'], /video entries set MODEL RESOLUTION ROUTE on\|off/],
    [['entries', 'set', 'wan-3.0', '720p', 'krea', 'true'], /video entries set MODEL RESOLUTION ROUTE on\|off/],
    [['entries', 'set', 'wan-3.0', '720p', 'krea'], /video entries set MODEL RESOLUTION ROUTE on\|off/],
    [['entries', 'set', 'wan-3.0', 'krea', 'on'], /video entries set MODEL RESOLUTION ROUTE on\|off/],
    [['entries', 'set', 'wan-3.0', '720p', 'krea', 'on', 'extra'], /video entries set MODEL RESOLUTION ROUTE on\|off/],
    [['entries', 'list'], /video entries set MODEL RESOLUTION ROUTE on\|off/],
    [['entries', 'on', 'wan-3.0', '720p', 'krea'], /video entries set MODEL RESOLUTION ROUTE on\|off/],
  ]) {
    await assert.rejects(s.exec(...args), pattern, args.join(' '));
    assert.deepEqual(snapshot(s.home), before, args.join(' '));
  }
  assert.deepEqual(s.seen, []);
});

test('video settings lists all eleven models and their routes, and says nothing about entries', async (t) => {
  const s = session(t);
  await s.exec('entries', 'set', 'wan-3.0', '720p', 'krea', 'on');
  const printed = await s.exec('settings');
  assert.deepEqual(printed, { models: [
    { model: 'seedance-2.5', enabled: false, route: null, routes: ['videorouter', 'kovapi', 'elevenlabs', 'krea'] },
    { model: 'seedance-2.0', enabled: false, route: null, routes: ['videorouter', 'kovapi', 'elevenlabs', 'krea'] },
    { model: 'minimax-h3', enabled: false, route: null, routes: ['kovapi', 'callirra', 'krea'] },
    { model: 'wan-3.0', enabled: false, route: null, routes: ['videorouter', 'videorouter-replicate', 'kovapi', 'krea'] },
    { model: 'flux-3', enabled: false, route: null, routes: ['videorouter', 'krea'] },
    ...['seedance-2.0-fast', 'seedance-2.0-mini', 'veo-3.1', 'veo-3.1-fast', 'aurora'].map((model) => ({ model, enabled: false, route: null, routes: ['elevenlabs'] })),
    { model: 'kling-v3-standard', enabled: false, route: null, routes: ['yotta'] },
  ] });
  assert.deepEqual(await s.exec('settings', 'set', 'flux-3', 'krea', 'enabled'), { models: printed.models.map((row) => (row.model === 'flux-3' ? { ...row, enabled: true, route: 'krea' } : row)) });
  assert.deepEqual((await s.exec('entries')).entries.filter((entry) => entry.on).map((entry) => entry.label), ['Wan 3.0 - 720p - Krea']);
});
test('a settings file far larger than any real one is refused, not read', async (t) => {
  const home = tempHome(t);
  // Valid JSON, 300,000 items that are not entries: before the limit this was read and walked in full.
  const huge = JSON.stringify({ models: {}, entries: Array.from({ length: 300000 }, () => 'x') });
  assert.ok(Buffer.byteLength(huge) > 1024 * 1024);
  fs.writeFileSync(file(home), huge);
  const before = snapshot(home);
  const tooLarge = /video-settings\.json is larger than 64 KB/;
  await assert.rejects(async () => video.entries(home), tooLarge);
  await assert.rejects(async () => video.entriesOn(home), tooLarge);
  await assert.rejects(async () => video.read(home), tooLarge);
  await assert.rejects(async () => video.setEntry(home, SEEDANCE, true), tooLarge);
  assert.deepEqual(snapshot(home), before, 'a refused file is left exactly as it was');
});

test('a settings file with every entry switched on is far below the size limit', async (t) => {
  const home = tempHome(t);
  for (const { model, resolution, route } of catalog.entries()) await video.setEntry(home, { model, resolution, route }, true);
  assert.equal((await video.entriesOn(home)).length, catalog.entries().length);
  assert.ok(fs.statSync(file(home)).size < 16 * 1024, `the full file is ${fs.statSync(file(home)).size} bytes`);
});
