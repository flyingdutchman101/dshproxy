'use strict';
require("./support/keychain"); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
// The child process of the video picker: one request in, the video command run
// once, the outcome of a purchase written before anything is printed, one line
// of checked fields out.
//
// Nothing here reaches a provider, a credential or the real Krea helper. The
// network is replaced by a function that fails, and the one place that starts
// the Krea helper (src/video/workspace.js) is loaded with a stand-in for
// `spawn`, so in this process the helper cannot be started even by mistake.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guard = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-picker-child-guard-'));
process.env.DSHPROXY_HOME = guard;
for (const name of ['VIDEOROUTER_API_KEY', 'KOVAPI_API_KEY', 'CALLIRRA_API_KEY']) delete process.env[name];
test.after(() => {
  try { assert.deepEqual(fs.readdirSync(guard), []); }
  finally { fs.rmSync(guard, { recursive: true, force: true }); }
});

let networkCalls = 0;
globalThis.fetch = () => { networkCalls += 1; throw new Error('this test file never uses the network'); };

// The stand-in for the Krea helper process: it answers what `helper` says.
const helper = { stderr: 'KREA_LOGIN_REQUIRED', stdout: '', code: 1, starts: [] };
const realSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  const child = new EventEmitter();
  child.kill = () => true;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = Object.assign(new EventEmitter(), { end(text) {
    helper.starts.push({ command, args, request: JSON.parse(text) });
    setImmediate(() => {
      if (helper.stdout) child.stdout.emit('data', helper.stdout);
      if (helper.stderr) child.stderr.emit('data', `${helper.stderr}\n`);
      child.emit('close', helper.code);
    });
  } });
  return child;
};
const workspace = require('../src/video/workspace');
childProcess.spawn = realSpawn;

const catalog = require('../src/video/catalog');
const command = require('../src/video/command');
const transport = require('../src/video/transport');
const entries = require('../src/video/picker/entries');
const child = require('../src/video/picker/child');

const CHILD_FILE = path.join(__dirname, '..', 'src', 'video', 'picker', 'child.js');
const SECRET = 'sk-PLANTED.secret/0123456789+abcdef=';
const NONCE = 'n0nce-0123456789abcdef';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-picker-child-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const offered = entries.byId(catalog.entries());
const entry = (id) => { const found = offered.get(id); assert.ok(found, id); return found; };
const usd = (micros) => `${Math.floor(micros / 1000000)}.${String(micros % 1000000).padStart(6, '0')}`;
const capOf = (item) => (item.unit === 'krea_units' ? '856.5' : item.unit === 'callirra_credits' ? String(item.credits) : usd(item.usdMicros));

async function caught(action) {
  try { await action(); } catch (error) { return error; }
  assert.fail('expected a failure');
}

// Runs the real video command with its two outside edges replaced. With
// `viaHelper` the command starts its Krea helper itself, which in this process
// is the stand-in above.
async function runReal(args, { workspaceAnswer, fetchAnswer, env = {}, loadMasterKey, viaHelper = false } = {}) {
  const seen = { workspace: [], fetch: [], lines: [] };
  const options = {
    env: { DSHPROXY_HOME: guard, ...env },
    workspace: viaHelper ? undefined : async (request) => { seen.workspace.push(request); if (workspaceAnswer === undefined) throw new Error('unexpected workspace call'); return workspaceAnswer(request); },
    fetchImpl: async (url, init) => { seen.fetch.push({ url: String(url), init }); if (fetchAnswer === undefined) throw new Error('unexpected network call'); return fetchAnswer(url, init); },
    ...(loadMasterKey ? { loadMasterKey } : {}),
  };
  await command.run(args, (text) => seen.lines.push(text), options);
  seen.result = JSON.parse(seen.lines.join('\n'));
  return seen;
}

// ------------------------------ argument lists ------------------------------

test('the argument lists have exactly the forms the video command takes', () => {
  const krea = entry('seedance-2.5/720p/krea');
  const tier = entry('minimax-h3/2k/krea');
  const dollars = entry('wan-3.0/1080p/videorouter-replicate');
  const credits = entry('minimax-h3/480p/callirra');
  assert.deepEqual(child.argsFor('quote', krea, { prompt: 'A red ball' }), ['quote', 'seedance-2.5', 'krea', '--resolution', '720p', '--prompt', 'A red ball']);
  assert.deepEqual(child.argsFor('submit', krea, { prompt: 'A red ball', cap: '856' }), ['submit', 'seedance-2.5', 'krea', '--max-units', '856', '--confirm-charge', '--resolution', '720p', 'A red ball']);
  assert.deepEqual(child.argsFor('status', krea, { jobId: 'job_1' }), ['status', 'seedance-2.5', 'krea', 'job_1', '--resolution', '720p']);
  // A fixed tier is sent no resolution.
  assert.deepEqual(child.argsFor('quote', tier, { prompt: 'A red ball' }), ['quote', 'minimax-h3', 'krea', '--prompt', 'A red ball']);
  assert.deepEqual(child.argsFor('submit', tier, { prompt: 'A red ball', cap: '481.481482' }), ['submit', 'minimax-h3', 'krea', '--max-units', '481.481482', '--confirm-charge', 'A red ball']);
  assert.deepEqual(child.argsFor('status', tier, { jobId: 'job_1' }), ['status', 'minimax-h3', 'krea', 'job_1']);
  assert.deepEqual(child.argsFor('quote', dollars), ['quote', 'wan-3.0', 'videorouter-replicate', '--resolution', '1080p']);
  assert.deepEqual(child.argsFor('submit', dollars, { prompt: 'A red ball', cap: '0.5125' }), ['submit', 'wan-3.0', 'videorouter-replicate', '--max-usd', '0.5125', '--confirm-charge', '--resolution', '1080p', 'A red ball']);
  assert.deepEqual(child.argsFor('status', dollars, { jobId: 'job_1' }), ['status', 'wan-3.0', 'videorouter-replicate', 'job_1', '--resolution', '1080p']);
  assert.deepEqual(child.argsFor('submit', credits, { prompt: 'A red ball', cap: '5' }), ['submit', 'minimax-h3', 'callirra', '--max-credits', '5', '--confirm-charge', '--resolution', '480p', 'A red ball']);
});

test('an argument list is never built from a prompt, cap, job id or entry that the command would not take', () => {
  const krea = entry('seedance-2.5/720p/krea');
  const dollars = entry('seedance-2.5/720p/kovapi');
  const credits = entry('minimax-h3/768p/callirra');
  const refused = [
    ['an unknown kind', () => child.argsFor('balance', krea, {})],
    ['a kind of key', () => child.argsFor('key', krea, {})],
    ['no entry', () => child.argsFor('quote', undefined, { prompt: 'x' })],
    ['an entry without a unit', () => child.argsFor('quote', { model: 'seedance-2.5', resolution: '720p', route: 'krea' }, { prompt: 'x' })],
    ['a unit that is not the route\'s', () => child.argsFor('submit', { ...krea, unit: 'usd_micros' }, { prompt: 'x', cap: '1' })],
    ['a Krea unit on an API route', () => child.argsFor('submit', { ...dollars, unit: 'krea_units' }, { prompt: 'x', cap: '1' })],
    ['a model that is an option', () => child.argsFor('quote', { ...krea, model: '--max-units' }, { prompt: 'x' })],
    ['a resolution with a space', () => child.argsFor('quote', { ...krea, resolution: '720p --x' }, { prompt: 'x' })],
    ['a route with a slash', () => child.argsFor('status', { ...krea, route: 'krea/x' }, { jobId: 'j' })],
    ['no prompt', () => child.argsFor('quote', krea, {})],
    ['an empty prompt', () => child.argsFor('submit', krea, { prompt: '   ', cap: '1' })],
    ['a prompt that is an option', () => child.argsFor('submit', krea, { prompt: '--resolution', cap: '1' })],
    ['a prompt that starts like an option', () => child.argsFor('quote', krea, { prompt: '--prompt x' })],
    ['a prompt over 16,000 bytes', () => child.argsFor('quote', krea, { prompt: 'đ'.repeat(8001) })],
    ['a prompt with a NUL', () => child.argsFor('quote', krea, { prompt: 'a\0b' })],
    ['a prompt that is not text', () => child.argsFor('submit', krea, { prompt: ['x'], cap: '1' })],
    ['no cap', () => child.argsFor('submit', krea, { prompt: 'x' })],
    ['a cap that is a number', () => child.argsFor('submit', krea, { prompt: 'x', cap: 856 })],
    ['a cap of zero units', () => child.argsFor('submit', krea, { prompt: 'x', cap: '0' })],
    ['a cap with seven decimals', () => child.argsFor('submit', krea, { prompt: 'x', cap: '1.1234567' })],
    ['a cap in exponent form', () => child.argsFor('submit', krea, { prompt: 'x', cap: '1e3' })],
    ['a negative cap', () => child.argsFor('submit', dollars, { prompt: 'x', cap: '-1' })],
    ['a dollar cap over six digits', () => child.argsFor('submit', dollars, { prompt: 'x', cap: '1234567' })],
    ['a credit cap with decimals', () => child.argsFor('submit', credits, { prompt: 'x', cap: '10.5' })],
    ['no job id', () => child.argsFor('status', krea, {})],
    ['a job id that is an option', () => child.argsFor('status', krea, { jobId: '--resolution' })],
    ['a job id with a slash', () => child.argsFor('status', dollars, { jobId: 'a/b' })],
  ];
  for (const [name, action] of refused) assert.throws(action, TypeError, name);
  // The longest prompt the command takes is accepted.
  assert.equal(child.argsFor('quote', krea, { prompt: 'x'.repeat(16000) }).at(-1).length, 16000);
});

test('for every entry of the real catalog, each list runs through the real command and the cap, the prompt and the resolution arrive', async () => {
  const prompt = 'A red ball rolls slowly across a wooden table';
  assert.ok(offered.size >= 30);
  for (const item of offered.values()) {
    const cap = capOf(item);
    const quoteArgs = child.argsFor('quote', item, { prompt });
    const submitArgs = child.argsFor('submit', item, { prompt, cap });
    const statusArgs = child.argsFor('status', item, { jobId: 'job-7' });
    if (item.route === 'krea') {
      const sends = item.fixedTier ? {} : { resolution: item.resolution };
      const quoted = await runReal(quoteArgs, { workspaceAnswer: () => ({ mode: 'preflight', compute_units: 856, is_estimated: false, available_compute_units: 97909.73, affordable: true }) });
      assert.deepEqual(quoted.workspace, [{ action: 'quote', model: item.model, prompt, ...sends }], item.id);
      const bought = await runReal(submitArgs, { workspaceAnswer: () => ({ id: 'job-7', status: 'scheduled' }) });
      assert.deepEqual(bought.workspace, [{ action: 'submit', model: item.model, prompt, maxUnits: 856.5, confirmCharge: true, ...sends }], item.id);
      assert.equal(bought.result.id, 'job-7');
      const state = await runReal(statusArgs, { workspaceAnswer: () => ({ id: 'job-7', status: 'processing' }) });
      assert.deepEqual(state.workspace, [{ action: 'status', model: item.model, jobId: 'job-7' }], item.id);
      for (const run of [quoted, bought, state]) assert.equal(run.fetch.length, 0);
      continue;
    }
    const keyName = item.route === 'callirra' ? 'CALLIRRA_API_KEY' : item.route === 'kovapi' ? 'KOVAPI_API_KEY' : 'VIDEOROUTER_API_KEY';
    const env = { [keyName]: 'synthetic-edge-test-key' };
    const job = (status) => () => Response.json(item.route === 'callirra' ? { job: { id: 'job-7', status } } : { id: 'job-7', status });
    // A published price: no request at all.
    const quoted = await runReal(quoteArgs, { env });
    assert.equal(quoted.fetch.length, 0, item.id);
    assert.equal(quoted.result.resolution, item.resolution);
    assert.equal(quoted.result.usdMicros, item.usdMicros);
    const bought = await runReal(submitArgs, { env, fetchAnswer: job('queued') });
    assert.equal(bought.fetch.length, 1, item.id);
    const sent = JSON.parse(bought.fetch[0].init.body);
    assert.equal(sent.prompt, prompt, item.id);
    assert.equal(sent.model, item.modelId, item.id);
    assert.equal(String(sent.resolution).toLowerCase(), item.resolution.toLowerCase(), item.id);
    assert.equal(bought.result.id, 'job-7');
    // The cap arrives: one step below the published price nothing is sent.
    const below = item.unit === 'callirra_credits' ? String(item.credits - 1) : usd(item.usdMicros - 1);
    const refused = await caught(() => runReal(child.argsFor('submit', item, { prompt, cap: below }), { env, fetchAnswer: job('queued') }));
    assert.match(refused.message, /no job submitted\.$/, item.id);
    const state = await runReal(statusArgs, { env, fetchAnswer: job('queued') });
    assert.equal(state.fetch.length, 1);
    assert.ok(state.fetch[0].url.endsWith('/job-7'), item.id);
    assert.equal(state.fetch[0].init.method, 'GET');
    for (const run of [quoted, bought, state]) assert.equal(run.workspace.length, 0);
  }
  assert.equal(networkCalls, 0);
  assert.deepEqual(helper.starts, []);
});

test('an entry handed over without its fixed-tier mark still reaches the same clip', async () => {
  const { fixedTier, ...tier } = entry('minimax-h3/2k/krea');
  assert.equal(fixedTier, true);
  const args = child.argsFor('submit', tier, { prompt: 'A red ball', cap: '482' });
  const bought = await runReal(args, { workspaceAnswer: () => ({ id: 'job-7', status: 'scheduled' }) });
  assert.deepEqual(bought.workspace, [{ action: 'submit', model: 'minimax-h3', prompt: 'A red ball', maxUnits: 482, confirmCharge: true }]);
});

// ------------------------- which failures are "not sent" -------------------------

// Each sentence is produced here by the real module that owns it. A sentence
// that is reworded there stops matching, and its case fails instead of turning
// a failure into "not sent" (or out of it) unseen.
const savedKeyHome = (t) => {
  const home = tempDir(t);
  fs.writeFileSync(path.join(home, 'video-keys.json'), JSON.stringify({ providers: { kovapi: { keyEnc: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } } }));
  return home;
};
const kovEnv = { KOVAPI_API_KEY: 'synthetic-edge-test-key' };
const fine = () => Response.json({ id: 'job-7', status: 'queued' });
const kreaSubmit = ['submit', 'seedance-2.5', 'krea', '--max-units', '856', '--confirm-charge', '--resolution', '720p', 'A red ball'];
const kovSubmit = ['submit', 'seedance-2.5', 'kovapi', '--max-usd', '0.79', '--confirm-charge', '--resolution', '720p', 'A red ball'];

const NOT_SENT = [
  ['sign-in', /^Krea workspace sign-in required\./, () => { Object.assign(helper, { stderr: 'KREA_LOGIN_REQUIRED', stdout: '', code: 1 }); return runReal(kreaSubmit, { viaHelper: true }); }],
  ['refused', /^Krea refused the request/, () => { Object.assign(helper, { stderr: 'KREA_REFUSED', stdout: '', code: 1 }); return runReal(kreaSubmit, { viaHelper: true }); }],
  ['bad-request', /^Krea workspace OAuth requires explicit workspace parameters\./, () => runReal(['submit', 'seedance-2.5', 'krea', '--max-units', '0', '--confirm-charge', 'A red ball'], { workspaceAnswer: () => ({ id: 'job-7', status: 'scheduled' }) })],
  ['bad-request', /^Krea workspace OAuth requires explicit workspace parameters\./, () => runReal(['submit', 'seedance-2.5', 'krea', '--max-usd', '1', '--confirm-charge', 'A red ball'], { workspaceAnswer: () => ({ id: 'job-7', status: 'scheduled' }) })],
  ['bad-request', /^Unknown video model$/, () => runReal(['submit', 'no-such-model', 'krea', '--max-units', '856', '--confirm-charge', 'A red ball'], { workspaceAnswer: () => ({ id: 'job-7', status: 'scheduled' }) })],
  ['bad-request', /^Unknown video model$/, () => runReal(['submit', 'no-such-model', 'kovapi', '--max-usd', '1', '--confirm-charge', 'A red ball'], { env: kovEnv, fetchAnswer: fine })],
  ['bad-request', /^Unsupported video route for flux-3$/, () => runReal(['submit', 'flux-3', 'kovapi', '--max-usd', '9', '--confirm-charge', 'A red ball'], { env: kovEnv, fetchAnswer: fine })],
  ['bad-request', /^Unsupported video route for seedance-2\.5$/, () => runReal(['submit', 'seedance-2.5', 'no-such-route', '--max-usd', '9', '--confirm-charge', 'A red ball'], { env: kovEnv, fetchAnswer: fine })],
  ['bad-request', /^Unsupported video resolution for seedance-2\.5 on kovapi: that combination is not an entry\./, () => runReal(['submit', 'seedance-2.5', 'kovapi', '--max-usd', '9', '--confirm-charge', '--resolution', '999p', 'A red ball'], { env: kovEnv, fetchAnswer: fine })],
  ['bad-request', /^Unsupported video resolution for flux-3 on krea: that combination is not an entry\./, () => runReal(['submit', 'flux-3', 'krea', '--max-units', '900', '--confirm-charge', '--resolution', '480p', 'A red ball'], { workspaceAnswer: () => ({ id: 'job-7', status: 'scheduled' }) })],
  ['bad-request', /^MiniMax H3 on Krea is a fixed tier \(2K\): it takes no resolution\.$/, () => runReal(['submit', 'minimax-h3', 'krea', '--max-units', '900', '--confirm-charge', '--resolution', '720p', 'A red ball'], { workspaceAnswer: () => ({ id: 'job-7', status: 'scheduled' }) })],
  ['bad-request', /^Invalid video route or model$/, () => transport.submit({ route: 'kovapi', modelId: 'no-such-model', resolution: '720p', key: 'synthetic-edge-test-key', prompt: 'A red ball', fetchImpl: async () => { networkCalls += 1; return fine(); } })],
  ['bad-request', /^Invalid video prompt$/, () => transport.submit({ route: 'kovapi', modelId: 'seedance-2.5', resolution: '720p', key: 'synthetic-edge-test-key', prompt: '   ', fetchImpl: async () => { networkCalls += 1; return fine(); } })],
  ['bad-request', /^Invalid video provider credential$/, () => runReal(kovSubmit, { env: { KOVAPI_API_KEY: 'synthetic key with spaces' }, fetchAnswer: fine })],
  ['over-cap', /^The quote exceeds --max-usd; no job submitted\.$/, () => runReal(['submit', 'seedance-2.5', 'kovapi', '--max-usd', '0.789999', '--confirm-charge', 'A red ball'], { env: kovEnv, fetchAnswer: fine })],
  ['over-cap', /^Insufficient credit budget; no job submitted\.$/, () => runReal(['submit', 'minimax-h3', 'callirra', '--max-credits', '9', '--confirm-charge', 'A red ball'], { env: { CALLIRRA_API_KEY: 'synthetic-edge-test-key' }, fetchAnswer: fine })],
  ['no-key', /^Set KOVAPI_API_KEY, or save a key .* No request sent\.$/, () => runReal(kovSubmit, { fetchAnswer: fine })],
  ['no-key', /^The saved kovapi key cannot be read\. .* No request sent\.$/, (t) => runReal(kovSubmit, { env: { DSHPROXY_HOME: savedKeyHome(t) }, loadMasterKey: async () => null, fetchAnswer: fine })],
];

test('each "not sent" sentence, produced by the real module that owns it, is recognised with its reason', async (t) => {
  for (const [reason, sentence, provoke] of NOT_SENT) {
    const startsBefore = helper.starts.length;
    const error = await caught(() => provoke(t));
    assert.ok(error instanceof Error, String(sentence));
    assert.match(error.message, sentence);
    assert.deepEqual(child.outcomeOf(error), { state: 'not-sent', reason }, error.message);
    assert.equal(child.reasonOf(error), reason);
    // The two Krea sentences come from the helper's own word, before any paid call; nothing else starts it.
    if (!['sign-in', 'refused'].includes(reason)) assert.equal(helper.starts.length, startsBefore);
  }
  // The table of the design, complete: five reasons.
  assert.deepEqual([...new Set(NOT_SENT.map(([reason]) => reason))], ['sign-in', 'refused', 'bad-request', 'over-cap', 'no-key']);
  assert.equal(networkCalls, 0, 'none of them reached the network');
  for (const start of helper.starts) assert.ok(start.args[0].endsWith(path.join('bin', 'dshproxy-krea.js')));
});

test('every other failure of the real modules is an unknown outcome, including one that says nothing was sent in other words', async () => {
  const unknown = [
    [/^Video submission unconfirmed; do not retry until provider history is checked\.$/, () => runReal(kovSubmit, { env: kovEnv, fetchAnswer: () => new Response('{"error":"x"}', { status: 500 }) })],
    [/^Video submission unconfirmed/, () => runReal(kovSubmit, { env: kovEnv, fetchAnswer: () => { throw new Error('socket hang up'); } })],
    [/^Video submission unconfirmed/, () => runReal(kovSubmit, { env: kovEnv, fetchAnswer: () => Response.json({ id: 'job 7', status: 'queued' }) })],
    [/^Invalid Krea job response\. Do not resubmit automatically\.$/, () => runReal(kreaSubmit, { workspaceAnswer: () => ({ mode: 'preflight' }) })],
    [/^Invalid Krea output URL\.$/, () => runReal(kreaSubmit, { workspaceAnswer: () => ({ id: 'job-7', status: 'scheduled', outputUrl: 'https://x.example/a.mp4' }) })],
    [/^Krea helper did not return a verified result\./, () => { Object.assign(helper, { stderr: 'KREA_UNCERTAIN', stdout: '', code: 1 }); return runReal(kreaSubmit, { viaHelper: true }); }],
    [/^Krea helper did not return a verified result\./, () => { Object.assign(helper, { stderr: '', stdout: 'not json', code: 0 }); return runReal(kreaSubmit, { viaHelper: true }); }],
    [/^Krea helper did not return a verified result\./, () => { Object.assign(helper, { stderr: 'Krea workspace sign-in required.', stdout: '', code: 1 }); return workspace.invoke({ action: 'submit' }); }],
    // Refused before any request, but not on the design's list: the list is closed.
    [/^--resolution takes one resolution/, () => runReal([...kovSubmit.slice(0, 6), '--resolution', '720p', '--resolution', '720p', 'A red ball'], { env: kovEnv, fetchAnswer: fine })],
    [/^Invalid USD budget/, () => runReal(['submit', 'seedance-2.5', 'kovapi', '--max-usd', 'Infinity', '--confirm-charge', 'A red ball'], { env: kovEnv, fetchAnswer: fine })],
    [/^dshproxy video list/, () => runReal(['submit', 'seedance-2.5', 'kovapi', '--max-usd', '1', 'A red ball'], { env: kovEnv, fetchAnswer: fine })],
  ];
  for (const [sentence, provoke] of unknown) {
    const error = await caught(provoke);
    assert.match(error.message, sentence);
    assert.deepEqual(child.outcomeOf(error), { state: 'unknown' }, error.message);
    assert.equal(child.reasonOf(error), null);
  }
  assert.equal(networkCalls, 0);
});

test('a sentence that only resembles one on the list, or is not an error at all, is an unknown outcome', () => {
  const near = [
    'Krea workspace sign in required.', 'krea workspace sign-in required.', ' Krea workspace sign-in required.', 'Error: Krea workspace sign-in required.',
    'Krea did not refuse the request', 'Maybe: Krea refused the request',
    'Unknown video model.', 'Unknown video models', 'Unsupported video route', 'Invalid video route or model!', 'Invalid video prompts', 'Invalid video provider credentials',
    'The quote exceeds --max-usd; no job submitted', 'The quote exceeds --max-usd; no job submitted. Or was it?', 'Insufficient credit budget.',
    'No request sent', 'No request sent. Probably.', 'no request sent.', '', 'not sent',
  ];
  for (const message of near) assert.deepEqual(child.outcomeOf(new Error(message)), { state: 'unknown' }, message);
  // Thrown things that are not errors, even with the right words.
  class Lookalike { constructor() { this.message = 'Unknown video model'; } }
  const exact = 'Unknown video model';
  for (const value of [exact, { message: exact }, new Lookalike(), Object.create(Error.prototype, { message: { value: 7 } }), null, undefined, 0, false, [], Symbol('x')]) {
    assert.deepEqual(child.outcomeOf(value), { state: 'unknown' });
    assert.equal(child.reasonOf(value), null);
  }
  // An error whose message getter throws.
  const hostile = new Error('x');
  Object.defineProperty(hostile, 'message', { get() { throw new Error('no'); } });
  assert.deepEqual(child.outcomeOf(hostile), { state: 'unknown' });
});

test('a result counts as submitted only with a valid job id and status', () => {
  assert.deepEqual(child.outcomeOf({ model: 'seedance-2.5', route: 'krea', id: 'job-7', status: 'scheduled', resolution: '720p' }), { state: 'submitted', jobId: 'job-7', status: 'scheduled' });
  // The text the command prints is read the same way.
  assert.deepEqual(child.outcomeOf(JSON.stringify({ id: 'vid_9', status: 'queued', model: 'minimax-h3', route: 'callirra', reservedCredits: 10 }, null, 2)), { state: 'submitted', jobId: 'vid_9', status: 'queued', reservedCredits: 10 });
  const malformed = [
    {}, { id: 'job-7' }, { status: 'queued' }, { id: '', status: 'queued' }, { id: 'job 7', status: 'queued' }, { id: '-job', status: 'queued' }, { id: 'a'.repeat(129), status: 'queued' },
    { id: 7, status: 'queued' }, { id: ['job-7'], status: 'queued' }, { id: 'job-7', status: 'Queued' }, { id: 'job-7', status: 'in progress' }, { id: 'job-7', status: '' }, { id: 'job-7', status: 7 },
    { id: 'job-7', status: 'q'.repeat(65) }, { jobId: 'job-7', status: 'queued' }, [{ id: 'job-7', status: 'queued' }], 'job-7', '', '{', 'null', '"job-7"', '[]', 7, true,
    `${JSON.stringify({ id: 'job-7', status: 'queued' })}\n${JSON.stringify({ id: 'job-8', status: 'queued' })}`,
  ];
  for (const value of malformed) assert.deepEqual(child.outcomeOf(value), { state: 'unknown' }, JSON.stringify(value));
});

// ----------------------------------- main -----------------------------------

// A fake `run`, a fake `writeOnce` and a fake `print`, with the order of what happened.
function harness({ result, error, lines } = {}) {
  const log = { order: [], runs: [], written: [], printed: [] };
  const deps = {
    run: async (args, out, options) => {
      log.order.push('run');
      log.runs.push({ args, options });
      if (error !== undefined) throw error;
      for (const line of lines || [JSON.stringify(result, null, 2)]) out(line);
    },
    writeOnce: (file, value) => { log.order.push('write'); log.written.push({ file, value: JSON.parse(JSON.stringify(value)) }); },
    print: (line) => { log.order.push('print'); log.printed.push(line); },
    // The outcome file is not there yet; its folder is.
    exists: (target) => target === path.dirname(OUTCOME),
  };
  return { log, deps };
}
const OUTCOME = path.join(os.tmpdir(), 'dshproxy-picker-child-never-written', 'outcomes', 'Q-AAAAAAAAAAAAAAAA.json');
const submitRequest = (extra = {}) => ({ kind: 'submit', args: ['submit', 'seedance-2.5', 'krea', '--max-units', '856', '--confirm-charge', '--resolution', '720p', 'A red ball'], outcomeFile: OUTCOME, nonce: NONCE, ...extra });
const printed = (log) => { assert.equal(log.printed.length, 1); assert.equal(log.printed[0].includes('\n'), false); return JSON.parse(log.printed[0]); };

test('a submit: the command runs once, the outcome is written with the nonce, and only then one line is printed', async () => {
  const { log, deps } = harness({ result: { model: 'seedance-2.5', route: 'krea', id: 'job-7', status: 'scheduled', resolution: '720p' } });
  const request = submitRequest();
  assert.equal(await child.main(request, deps), 0);
  assert.deepEqual(log.order, ['run', 'write', 'print']);
  assert.deepEqual(log.runs[0].args, request.args);
  assert.equal(log.runs[0].options.env, process.env);
  assert.deepEqual(Object.keys(log.runs[0].options), ['env']);
  assert.deepEqual(log.written, [{ file: OUTCOME, value: { nonce: NONCE, state: 'submitted', jobId: 'job-7', status: 'scheduled' } }]);
  assert.deepEqual(printed(log), { v: 1, kind: 'submit', ok: true, state: 'submitted', jobId: 'job-7', status: 'scheduled', recorded: true });
});

test('a submit that fails with a "not sent" sentence, with anything else, or with a malformed result', async () => {
  const cases = [
    [{ error: new Error('Krea workspace sign-in required. Run the dedicated helper login explicitly.') }, { state: 'not-sent', reason: 'sign-in' }],
    [{ error: new Error('The quote exceeds --max-usd; no job submitted.') }, { state: 'not-sent', reason: 'over-cap' }],
    [{ error: new Error('Video submission unconfirmed; do not retry until provider history is checked.') }, { state: 'unknown' }],
    [{ error: new Error('something nobody thought of') }, { state: 'unknown' }],
    [{ error: 'Unknown video model' }, { state: 'unknown' }],
    [{ error: null }, { state: 'unknown' }],
    [{ result: { id: 'job 7', status: 'scheduled' } }, { state: 'unknown' }],
    [{ result: { status: 'scheduled' } }, { state: 'unknown' }],
    [{ lines: [] }, { state: 'unknown' }],
    [{ lines: ['not json'] }, { state: 'unknown' }],
    [{ lines: ['{"id":"job-7","status":"queued"}', '{"id":"job-8","status":"queued"}'] }, { state: 'unknown' }],
    // A thrown value that looks like a result is a failure, not a job.
    [{ error: { id: 'job-7', status: 'queued' } }, { state: 'unknown' }],
    [{ error: '{"id":"job-7","status":"queued"}' }, { state: 'unknown' }],
  ];
  for (const [given, outcome] of cases) {
    const { log, deps } = harness(given);
    assert.equal(await child.main(submitRequest(), deps), 0);
    assert.deepEqual(log.order, ['run', 'write', 'print'], JSON.stringify(outcome));
    assert.deepEqual(log.written[0].value, { nonce: NONCE, ...outcome });
    assert.deepEqual(printed(log), { v: 1, kind: 'submit', ok: false, ...outcome, recorded: true });
  }
});

test('a quote: checked numbers only, in the entry\'s own unit', async () => {
  const quote = (result) => ({ kind: 'quote', args: ['quote', 'seedance-2.5', result.route, '--resolution', '720p'] });
  const krea = { model: 'seedance-2.5', route: 'krea', mode: 'preflight', compute_units: 380.33333333333326, is_estimated: true, available_compute_units: 97909.73, affordable: true, currency: 'workspace_compute_units', budgetFlag: '--max-units', resolution: '720p' };
  let run = harness({ result: krea });
  assert.equal(await child.main(quote(krea), run.deps), 0);
  assert.deepEqual(run.log.order, ['run', 'print']);
  assert.deepEqual(printed(run.log), { v: 1, kind: 'quote', ok: true, unit: 'krea_units', amount: 380.33333333333326, available: 97909.73, estimated: true, affordable: true });

  const dollars = { model: 'seedance-2.5', route: 'kovapi', resolution: '720p', durationSeconds: 5, aspectRatio: '16:9', verifiedOn: '2026-11-21', priceBasis: 'published', modelId: 'seedance-2.5', usdMicros: 790000, sourceUrls: ['https://kovapi.com/model/seedance-2.5'], currency: 'USD', amount: 0.79, budgetFlag: '--max-usd', estimatedUsd: 0.79 };
  run = harness({ result: dollars });
  assert.equal(await child.main(quote(dollars), run.deps), 0);
  assert.deepEqual(printed(run.log), { v: 1, kind: 'quote', ok: true, unit: 'usd_micros', amount: 790000, verifiedOn: '2026-11-21' });

  const credits = { model: 'minimax-h3', route: 'callirra', resolution: '768p', verifiedOn: '2026-11-21', priceBasis: 'effective', modelId: 'minimax-h3', usdMicros: 99667, credits: 10, assumption: 'Full use', currency: 'credits', amount: 10, budgetFlag: '--max-credits', estimatedUsd: 0.099667 };
  run = harness({ result: credits });
  assert.equal(await child.main(quote(credits), run.deps), 0);
  assert.deepEqual(printed(run.log), { v: 1, kind: 'quote', ok: true, unit: 'callirra_credits', amount: 10, usdMicros: 99667, verifiedOn: '2026-11-21' });

  const broken = [
    { ...krea, compute_units: '856' }, { ...krea, compute_units: -1 }, { ...krea, compute_units: null }, { ...krea, available_compute_units: undefined }, { ...krea, affordable: 'yes' },
    { ...krea, is_estimated: 0 }, { ...krea, currency: 'units' }, { ...dollars, usdMicros: 0.79 }, { ...dollars, usdMicros: -5 }, { ...dollars, verifiedOn: 'yesterday' },
    { ...credits, credits: 10.5 }, { ...credits, credits: undefined }, { id: 'job-7', status: 'queued' }, {},
  ];
  for (const result of broken) {
    run = harness({ result });
    assert.equal(await child.main(quote(krea), run.deps), 0);
    assert.deepEqual(printed(run.log), { v: 1, kind: 'quote', ok: false, reason: 'failed' }, JSON.stringify(result));
  }
  // A failure is a reason code and nothing else.
  for (const [message, reason] of [['Krea workspace sign-in required. Run the dedicated helper login explicitly.', 'sign-in'], ['Krea refused the request; the exact schema, budget, or workspace requirements were not met.', 'refused'], ['Unknown video model', 'bad-request'], ['Invalid Krea preflight quote', 'failed'], [`weird ${SECRET}`, 'failed']]) {
    run = harness({ error: new Error(message) });
    assert.equal(await child.main(quote(krea), run.deps), 0);
    assert.deepEqual(run.log.order, ['run', 'print']);
    assert.deepEqual(printed(run.log), { v: 1, kind: 'quote', ok: false, reason });
  }
});

test('a status: the job id that was asked about, its status, and a link only when it is one checked https link of a finished job', async () => {
  const request = { kind: 'status', args: ['status', 'seedance-2.5', 'krea', 'job-7', '--resolution', '720p'] };
  const check = async (result, expected) => {
    const run = harness({ result });
    assert.equal(await child.main(request, run.deps), 0);
    assert.deepEqual(run.log.order, ['run', 'print']);
    assert.deepEqual(printed(run.log), { v: 1, kind: 'status', ...expected }, JSON.stringify(result));
  };
  await check({ model: 'seedance-2.5', route: 'krea', id: 'job-7', status: 'processing' }, { ok: true, jobId: 'job-7', status: 'processing' });
  await check({ id: 'job-7', status: 'completed', outputUrl: 'https://app-uploads.krea.ai/public/abc.mp4' }, { ok: true, jobId: 'job-7', status: 'completed', outputUrl: 'https://app-uploads.krea.ai/public/abc.mp4' });
  await check({ id: 'job-7', status: 'succeeded', outputUrl: 'https://cdn.example/v.mp4?sig=a%20b&x=1' }, { ok: true, jobId: 'job-7', status: 'succeeded', outputUrl: 'https://cdn.example/v.mp4?sig=a%20b&x=1' });
  await check({ id: 'job-7', status: 'completed', chargedUsd: 0.85, reservedCredits: 10 }, { ok: true, jobId: 'job-7', status: 'completed', chargedUsd: 0.85, reservedCredits: 10 });
  await check({ id: 'job-7', status: 'failed', chargedUsd: '0.85', reservedCredits: -1 }, { ok: true, jobId: 'job-7', status: 'failed' });
  // Links that are left out: the job is reported without one.
  for (const outputUrl of ['http://cdn.example/v.mp4', 'https://user:pass@cdn.example/v.mp4', 'https://user@cdn.example/v.mp4', 'ftp://cdn.example/v.mp4', 'javascript:alert(1)', 'cdn.example/v.mp4', '',
    'https://cdn.example/v.mp4#frag', 'https://cdn.example/a b.mp4', 'https://cdn.example/v.mp4)[x](https://evil.example', 'https://cdn.example/<script>', 'https://cdn.example/a"b', 'https://cdn.example/a`b', 'https://cdn.example/a\\b',
    `https://cdn.example/${'a'.repeat(8200)}`, ['https://cdn.example/v.mp4'], { href: 'https://cdn.example/v.mp4' }, 7, null]) {
    await check({ id: 'job-7', status: 'completed', outputUrl }, { ok: true, jobId: 'job-7', status: 'completed' });
  }
  // A link of a job that is not finished is not shown either.
  await check({ id: 'job-7', status: 'processing', outputUrl: 'https://cdn.example/v.mp4' }, { ok: true, jobId: 'job-7', status: 'processing' });
  // Another job's answer, or no job at all, is a failure.
  await check({ id: 'job-8', status: 'processing' }, { ok: false, reason: 'failed' });
  await check({ id: 'job-7', status: 'In Progress' }, { ok: false, reason: 'failed' });
  await check({}, { ok: false, reason: 'failed' });
  for (const [message, reason] of [['Krea workspace sign-in required. Run the dedicated helper login explicitly.', 'sign-in'], ['Video job status could not be verified.', 'failed'], ['Set KOVAPI_API_KEY, or save a key with `dshproxy video key set kovapi`. No request sent.', 'no-key']]) {
    const run = harness({ error: new Error(message) });
    assert.equal(await child.main(request, run.deps), 0);
    assert.deepEqual(printed(run.log), { v: 1, kind: 'status', ok: false, reason });
  }
});

test('the outcome file is really written once: created whole, and an existing one is never overwritten', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'Q-AAAAAAAAAAAAAAAA.json');
  // Fresh: the default writer creates it before the line is printed.
  let run = harness({ result: { id: 'job-7', status: 'scheduled' } });
  let before;
  const { writeOnce, exists, ...deps } = run.deps;
  deps.print = (line) => { before = fs.readFileSync(file, 'utf8'); run.log.printed.push(line); };
  assert.equal(await child.main(submitRequest({ outcomeFile: file }), deps), 0);
  assert.deepEqual(JSON.parse(before), { nonce: NONCE, state: 'submitted', jobId: 'job-7', status: 'scheduled' });
  assert.equal(printed(run.log).recorded, true);
  assert.deepEqual(fs.readdirSync(dir), ['Q-AAAAAAAAAAAAAAAA.json']);

  // Already there when the child starts: nothing is run, nothing printed, the file is as it was.
  run = harness({ result: { id: 'job-8', status: 'scheduled' } });
  const { writeOnce: w2, exists: e2, ...deps2 } = run.deps;
  assert.notEqual(await child.main(submitRequest({ outcomeFile: file, nonce: 'another-nonce-123' }), deps2), 0);
  assert.deepEqual(run.log.order, []);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  // Appearing while the command runs: the purchase happened, the line says so and that it was not recorded.
  const late = path.join(dir, 'Q-BBBBBBBBBBBBBBBB.json');
  run = harness({ result: { id: 'job-9', status: 'scheduled' } });
  const realRun = run.deps.run;
  const { writeOnce: w3, exists: e3, ...deps3 } = run.deps;
  deps3.run = async (...args) => { fs.writeFileSync(late, 'someone else was here'); return realRun(...args); };
  assert.equal(await child.main(submitRequest({ outcomeFile: late }), deps3), 0);
  assert.equal(fs.readFileSync(late, 'utf8'), 'someone else was here');
  assert.deepEqual(printed(run.log), { v: 1, kind: 'submit', ok: true, state: 'submitted', jobId: 'job-9', status: 'scheduled', recorded: false });
  assert.equal(run.log.runs.length, 1);

  // A folder that is not there: the purchase is not started at all.
  run = harness({ result: { id: 'job-10', status: 'scheduled' } });
  const { writeOnce: w4, exists: e4, ...deps4 } = run.deps;
  assert.notEqual(await child.main(submitRequest({ outcomeFile: path.join(dir, 'no-such-folder', 'Q-CCCCCCCCCCCCCCCC.json') }), deps4), 0);
  assert.deepEqual(run.log.order, []);
});

test('a writer that fails does not hide what happened, and a printer that fails does not undo the record', async () => {
  let run = harness({ result: { id: 'job-7', status: 'scheduled' } });
  run.deps.writeOnce = () => { run.log.order.push('write'); throw Object.assign(new Error(`disk ${SECRET}`), { code: 'EIO' }); };
  assert.equal(await child.main(submitRequest(), run.deps), 0);
  assert.deepEqual(run.log.order, ['run', 'write', 'print']);
  assert.deepEqual(printed(run.log), { v: 1, kind: 'submit', ok: true, state: 'submitted', jobId: 'job-7', status: 'scheduled', recorded: false });
  run = harness({ result: { id: 'job-7', status: 'scheduled' } });
  run.deps.print = () => { run.log.order.push('print'); throw new Error('the pipe is closed'); };
  assert.equal(await child.main(submitRequest(), run.deps), 0);
  assert.deepEqual(run.log.order, ['run', 'write', 'print']);
  assert.equal(run.log.written.length, 1);
});

test('a secret-shaped string in any free-text field of a result or an error reaches no printed line and no outcome file', async (t) => {
  const dir = tempDir(t);
  const everything = [];
  let count = 0;
  const attempt = async (kind, given) => {
    count += 1;
    const file = path.join(dir, `Q-${String(count).padStart(16, 'A')}.json`);
    const run = harness(given);
    const { writeOnce, exists, ...deps } = run.deps;
    const request = kind === 'submit' ? submitRequest({ outcomeFile: file }) : { kind, args: kind === 'quote' ? ['quote', 'seedance-2.5', 'krea', '--prompt', 'x'] : ['status', 'seedance-2.5', 'krea', 'job-7'] };
    assert.equal(await child.main(request, deps), 0);
    everything.push(...run.log.printed);
    if (kind === 'submit') everything.push(fs.readFileSync(file, 'utf8'));
  };
  const loud = (message) => {
    const error = new Error(message);
    error.stack = `Error: ${SECRET}\n    at ${SECRET}`;
    error.code = SECRET;
    error.cause = new Error(SECRET);
    error.stderr = SECRET;
    error.stdout = SECRET;
    error.name = SECRET;
    return error;
  };
  const extras = { note: SECRET, message: SECRET, error: SECRET, detail: { token: SECRET }, model: SECRET, route: SECRET, resolution: SECRET, raw: [SECRET], [SECRET]: 'x', nonce: SECRET, state: SECRET, reason: SECRET };
  for (const kind of ['submit', 'quote', 'status']) {
    await attempt(kind, { error: loud(`failed with ${SECRET}`) });
    await attempt(kind, { error: loud(`Krea refused the request ${SECRET}`) });
    await attempt(kind, { error: loud(`Unsupported video route for ${SECRET}`) });
    await attempt(kind, { error: loud(`${SECRET} No request sent.`) });
    await attempt(kind, { error: SECRET });
    await attempt(kind, { error: { message: SECRET, toString: () => SECRET } });
    await attempt(kind, { lines: [SECRET] });
    await attempt(kind, { lines: [SECRET, JSON.stringify({ id: 'job-7', status: 'queued' })] });
    await attempt(kind, { result: { id: 'job-7', status: 'queued', ...extras } });
    await attempt(kind, { result: { id: SECRET, status: 'queued', ...extras } });
    await attempt(kind, { result: { id: 'job-7', status: SECRET, ...extras } });
    await attempt(kind, { result: { id: 'job-7', status: 'completed', outputUrl: `https://user:${encodeURIComponent(SECRET)}@cdn.example/v.mp4`, ...extras } });
    await attempt(kind, { result: { id: 'job-7', status: 'completed', outputUrl: SECRET, chargedUsd: SECRET, reservedCredits: SECRET, ...extras } });
    await attempt(kind, { result: { mode: 'preflight', compute_units: 856, is_estimated: false, available_compute_units: 9, affordable: false, currency: 'workspace_compute_units', budgetFlag: SECRET, ...extras } });
    await attempt(kind, { result: { usdMicros: 790000, verifiedOn: SECRET, currency: 'USD', assumption: SECRET, sourceUrls: [SECRET], ...extras } });
    await attempt(kind, { result: { usdMicros: 790000, verifiedOn: '2026-11-21', currency: SECRET, ...extras } });
  }
  assert.equal(everything.length, 16 * 3 + 16);
  for (const text of everything) {
    assert.equal(text.includes('PLANTED'), false, text);
    assert.equal(text.includes('sk-'), false, text);
  }
});

test('input that is not one valid request runs nothing', async () => {
  const good = submitRequest();
  const line = (value) => `${JSON.stringify(value)}\n`;
  assert.deepEqual(child.parseRequest(line(good)), good);
  assert.deepEqual(child.parseRequest(JSON.stringify(good)), good);
  assert.deepEqual(child.parseRequest(Buffer.from(`${JSON.stringify(good)}\r\n`)), good);
  const status = { kind: 'status', args: ['status', 'seedance-2.5', 'krea', 'job-7'] };
  assert.deepEqual(child.parseRequest(line(status)), status);
  const malformedText = [
    '', '\n', 'not json\n', '{\n', 'null\n', '7\n', '"submit"\n', `[${JSON.stringify(good)}]\n`,
    `${JSON.stringify(good)}\n${JSON.stringify(good)}\n`, `${JSON.stringify(good, null, 2)}\n`, `\n${JSON.stringify(good)}\n`,
    line({ ...status, args: [...status.args, 'x'.repeat(64 * 1024)] }),
    Buffer.concat([Buffer.from('{"kind":"status","args":["status","m","r","'), Buffer.from([0xff, 0xfe]), Buffer.from('"]}\n')]),
  ];
  for (const text of malformedText) assert.equal(child.parseRequest(text), null, String(text).slice(0, 60));
  assert.equal(child.MAX_REQUEST_BYTES, 64 * 1024);
  const malformed = [
    null, undefined, 'submit', [], { kind: 'submit' }, { ...good, kind: 'buy' }, { ...good, kind: 'balance', args: ['balance', 'krea'] }, { ...good, kind: 'key', args: ['key', 'set', 'kovapi'] },
    { ...good, args: 'submit' }, { ...good, args: [] }, { ...good, args: ['submit'] }, { ...good, args: [...good.args.slice(0, 8), 7] }, { ...good, args: [...good.args.slice(0, 8), null] },
    // The first word must be the kind: a status request cannot carry a submit.
    { kind: 'status', args: good.args }, { kind: 'quote', args: good.args }, { ...good, args: ['status', ...good.args.slice(1)] }, { ...good, args: ['settings', 'set', 'seedance-2.5', 'krea', 'enabled'] },
    { ...good, args: Array(40).fill('x') },
    // A purchase without a place for its outcome, or without its nonce, is not started.
    { kind: 'submit', args: good.args }, { ...good, outcomeFile: undefined }, { ...good, nonce: undefined }, { ...good, outcomeFile: 'outcomes/Q-1.json' }, { ...good, outcomeFile: '' }, { ...good, outcomeFile: 7 },
    { ...good, outcomeFile: `${OUTCOME}\0x` }, { ...good, nonce: '' }, { ...good, nonce: 'with space' }, { ...good, nonce: 'line\nbreak' }, { ...good, nonce: 'n'.repeat(257) }, { ...good, nonce: 7 },
    { ...good, extra: true }, { ...status, env: { KOVAPI_API_KEY: 'x' } }, { ...status, outcomeFile: 7 },
  ];
  for (const request of malformed) {
    const { log, deps } = harness({ result: { id: 'job-7', status: 'queued' } });
    assert.notEqual(await child.main(request, deps), 0, JSON.stringify(request));
    assert.deepEqual(log.order, [], JSON.stringify(request));
    if (request !== undefined) assert.equal(child.parseRequest(line(request)), null, JSON.stringify(request));
  }
});

test('the process entry reads standard input to its end, runs one valid request, and refuses the rest with a non-zero code', async () => {
  const input = (...chunks) => Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  const status = { kind: 'status', args: ['status', 'seedance-2.5', 'krea', 'job-7'] };
  let run = harness({ result: { id: 'job-7', status: 'processing' } });
  const text = `${JSON.stringify(status)}\n`;
  assert.equal(await child.start({ input: input(text.slice(0, 10), text.slice(10)), ...run.deps }), 0);
  assert.deepEqual(run.log.order, ['run', 'print']);
  assert.deepEqual(printed(run.log), { v: 1, kind: 'status', ok: true, jobId: 'job-7', status: 'processing' });
  for (const chunks of [[], ['garbage\n'], [text, text], [`${JSON.stringify({ ...status, args: [...status.args, 'x'.repeat(70000)] })}\n`], ['x'.repeat(40000), 'x'.repeat(40000)]]) {
    run = harness({ result: { id: 'job-7', status: 'processing' } });
    assert.notEqual(await child.start({ input: input(...chunks), ...run.deps }), 0);
    assert.deepEqual(run.log.order, []);
  }
  // An input that fails while being read.
  run = harness({ result: { id: 'job-7', status: 'processing' } });
  const failing = new Readable({ read() { this.destroy(new Error('broken pipe')); } });
  assert.notEqual(await child.start({ input: failing, ...run.deps }), 0);
  assert.deepEqual(run.log.order, []);
});

test('the real child, started with input that is not a request, exits non-zero and prints nothing', () => {
  for (const input of ['', 'not a request\n', '{"kind":"status"}\n', `${'x'.repeat(70000)}\n`]) {
    const env = { DSHPROXY_HOME: guard };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const result = childProcess.spawnSync(process.execPath, [CHILD_FILE], { input, env, encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.notEqual(result.status, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

// -------------------------------- spawnChild --------------------------------

const LISTED = ['SystemRoot', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'USERPROFILE', 'DSHPROXY_HOME'];
const KEYS = ['VIDEOROUTER_API_KEY', 'KOVAPI_API_KEY', 'CALLIRRA_API_KEY'];
const parentEnv = (extra = {}) => ({
  ...Object.fromEntries(LISTED.map((name) => [name, `value-of-${name}`])),
  ...Object.fromEntries(KEYS.map((name) => [name, `synthetic-${name}`])),
  PATH: 'C:\\somewhere', NODE_OPTIONS: '--no-warnings', NODE_PATH: 'C:\\modules', NODE_EXTRA_CA_CERTS: 'C:\\ca.pem', HTTPS_PROXY: 'http://proxy.example',
  ANTHROPIC_API_KEY: SECRET, OPENAI_API_KEY: SECRET, DSHPROXY_API_KEY: SECRET, DSH_HOME: 'C:\\dsh', KREA_API_TOKEN: SECRET, PICKER_EDGE_PLANTED: SECRET,
  ...extra,
});

test('the child\'s environment is the fixed list, the provider keys only for an API route, and the data folder it is told', () => {
  assert.deepEqual(child.ENVIRONMENT, LISTED);
  assert.deepEqual(child.KEY_VARIABLES, KEYS);
  const kreaRequest = { kind: 'status', args: ['status', 'seedance-2.5', 'krea', 'job-7'] };
  const apiRequest = { kind: 'status', args: ['status', 'seedance-2.5', 'kovapi', 'job-7'] };
  const forKrea = child.environment(parentEnv(), kreaRequest);
  assert.deepEqual(Object.keys(forKrea), LISTED);
  for (const name of LISTED) assert.equal(forKrea[name], `value-of-${name}`);
  const forApi = child.environment(parentEnv(), apiRequest);
  assert.deepEqual(Object.keys(forApi), [...LISTED, ...KEYS]);
  for (const name of KEYS) assert.equal(forApi[name], `synthetic-${name}`);
  // Only what is set is copied; nothing is invented.
  assert.deepEqual(child.environment({ SystemRoot: 'C:\\Windows', KOVAPI_API_KEY: '', CALLIRRA_API_KEY: 'k', TEMP: undefined, PICKER_EDGE_PLANTED: SECRET }, apiRequest), { SystemRoot: 'C:\\Windows', CALLIRRA_API_KEY: 'k' });
  // The data folder of the gateway wins over the one in the environment.
  assert.equal(child.environment(parentEnv(), kreaRequest, 'D:\\gateway-home').DSHPROXY_HOME, 'D:\\gateway-home');
  assert.equal(child.environment({}, kreaRequest, 'D:\\gateway-home').DSHPROXY_HOME, 'D:\\gateway-home');
  assert.equal(JSON.stringify([forKrea, forApi]).includes('PLANTED'), false);
});

// A stand-in for a started process.
function fakeProcess() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.kills = 0;
  proc.unrefs = 0;
  proc.kill = () => { proc.kills += 1; return true; };
  proc.unref = () => { proc.unrefs += 1; };
  proc.stdin = Object.assign(new EventEmitter(), { ended: [], end(text) { this.ended.push(text); }, write() { throw new Error('standard input is written once'); } });
  proc.stdout = Object.assign(new EventEmitter(), { setEncoding() {}, unref() {} });
  proc.stderr = null;
  proc.answer = (text, code = 0) => { if (text) proc.stdout.emit('data', Buffer.from(text)); proc.emit('close', code, null); };
  return proc;
}
function fakeSpawn() {
  const calls = [];
  const spawn = (command, args, options) => { const proc = fakeProcess(); calls.push({ command, args, options, proc }); return proc; };
  return { spawn, calls };
}
const statusRequest = { kind: 'status', args: ['status', 'seedance-2.5', 'kovapi', 'job-7', '--resolution', '720p'] };

test('the child is started without a shell, hidden, with the fixed environment, and its request is written once as one line', async () => {
  const { spawn, calls } = fakeSpawn();
  const waiting = child.spawnChild(statusRequest, { execPath: 'C:\\node\\node.exe', env: parentEnv(), home: 'D:\\gateway-home', spawn });
  assert.equal(calls.length, 1);
  const { command, args, options, proc } = calls[0];
  assert.equal(command, 'C:\\node\\node.exe');
  assert.deepEqual(args, [CHILD_FILE]);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore'], 'standard error of the child is never read');
  assert.deepEqual(Object.keys(options.env), [...LISTED, ...KEYS]);
  assert.equal(options.env.DSHPROXY_HOME, 'D:\\gateway-home');
  assert.equal(options.detached, undefined);
  assert.deepEqual(proc.stdin.ended, [`${JSON.stringify(statusRequest)}\n`]);
  // The prompt of a request travels on standard input only.
  assert.equal(JSON.stringify([command, args]).includes('job-7'), false);
  proc.answer(`${JSON.stringify({ v: 1, kind: 'status', ok: true, jobId: 'job-7', status: 'completed', outputUrl: 'https://cdn.example/v.mp4', note: SECRET })}\n`);
  assert.deepEqual(await waiting, { ok: true, started: true, result: { v: 1, kind: 'status', ok: true, jobId: 'job-7', status: 'completed', outputUrl: 'https://cdn.example/v.mp4' } });
  assert.equal(proc.kills, 0);
});

test('what comes back from the child is checked again, and anything else is a failure without text', { timeout: 30000 }, async () => {
  const good = { v: 1, kind: 'status', ok: true, jobId: 'job-7', status: 'processing' };
  const cases = [
    [`${JSON.stringify(good)}\n`, 0, { ok: true, started: true, result: good }],
    [JSON.stringify(good), 0, { ok: true, started: true, result: good }],
    [`${JSON.stringify({ v: 1, kind: 'status', ok: false, reason: 'sign-in' })}\n`, 0, { ok: true, started: true, result: { v: 1, kind: 'status', ok: false, reason: 'sign-in' } }],
    [`${JSON.stringify(good)}\n`, 1, { ok: false, started: true, why: 'exit' }],
    ['', 2, { ok: false, started: true, why: 'exit' }],
    ['', 0, { ok: false, started: true, why: 'output' }],
    [`${SECRET}\n`, 0, { ok: false, started: true, why: 'output' }],
    [`${JSON.stringify(good)}\n${JSON.stringify(good)}\n`, 0, { ok: false, started: true, why: 'output' }],
    [`${JSON.stringify({ ...good, kind: 'submit', state: 'submitted', recorded: true })}\n`, 0, { ok: false, started: true, why: 'output' }],
    [`${JSON.stringify({ ...good, v: 2 })}\n`, 0, { ok: false, started: true, why: 'output' }],
    [`${JSON.stringify({ ...good, jobId: SECRET })}\n`, 0, { ok: false, started: true, why: 'output' }],
    [`${JSON.stringify({ ...good, status: SECRET })}\n`, 0, { ok: false, started: true, why: 'output' }],
    [`${JSON.stringify({ ...good, ok: false, reason: SECRET })}\n`, 0, { ok: false, started: true, why: 'output' }],
    [`${JSON.stringify({ ...good, jobId: 'job-8' })}\n`, 0, { ok: false, started: true, why: 'output' }],
    ['x'.repeat(70000), 0, { ok: false, started: true, why: 'output' }],
  ];
  for (const [text, code, expected] of cases) {
    const { spawn, calls } = fakeSpawn();
    const waiting = child.spawnChild(statusRequest, { env: {}, spawn });
    calls[0].proc.answer(text, code);
    const result = await waiting;
    assert.deepEqual(result, expected, text.slice(0, 80));
    assert.equal(JSON.stringify(result).includes('PLANTED'), false);
  }
  // A submit line: state, job, and whether the outcome was recorded.
  for (const line of [
    { v: 1, kind: 'submit', ok: true, state: 'submitted', jobId: 'job-7', status: 'scheduled', recorded: true },
    { v: 1, kind: 'submit', ok: false, state: 'not-sent', reason: 'over-cap', recorded: true },
    { v: 1, kind: 'submit', ok: false, state: 'unknown', recorded: false },
  ]) {
    const { spawn, calls } = fakeSpawn();
    const waiting = child.spawnChild(submitRequest(), { env: {}, spawn });
    calls[0].proc.answer(`${JSON.stringify({ ...line, note: SECRET })}\n`);
    assert.deepEqual(await waiting, { ok: true, started: true, result: line });
  }
  for (const line of [
    { v: 1, kind: 'submit', ok: true, state: 'submitted', jobId: 'job 7', status: 'scheduled', recorded: true },
    { v: 1, kind: 'submit', ok: true, state: 'not-sent', reason: 'over-cap', recorded: true },
    { v: 1, kind: 'submit', ok: false, state: 'not-sent', reason: 'because', recorded: true },
    { v: 1, kind: 'submit', ok: false, state: 'maybe', recorded: true },
    { v: 1, kind: 'submit', ok: false, state: 'unknown' },
  ]) {
    const { spawn, calls } = fakeSpawn();
    const waiting = child.spawnChild(submitRequest(), { env: {}, spawn });
    calls[0].proc.answer(`${JSON.stringify(line)}\n`);
    assert.deepEqual(await waiting, { ok: false, started: true, why: 'output' }, JSON.stringify(line));
  }
});

test('a request that is not valid, or too large for one line, starts no process', { timeout: 30000 }, async () => {
  const { spawn, calls } = fakeSpawn();
  for (const request of [null, {}, { kind: 'status', args: ['submit', 'm', 'r', 'j'] }, { kind: 'submit', args: submitRequest().args }, { ...statusRequest, args: [...statusRequest.args, 'x'.repeat(70000)] }]) {
    assert.deepEqual(await child.spawnChild(request, { env: {}, spawn }), { ok: false, started: false, why: 'request' });
  }
  assert.equal(calls.length, 0);
});

test('a process that cannot be started is reported as not started', { timeout: 30000 }, async () => {
  const thrown = await child.spawnChild(statusRequest, { env: {}, spawn: () => { throw new Error(`EPERM ${SECRET}`); } });
  assert.deepEqual(thrown, { ok: false, started: false, why: 'spawn' });
  const spawn = () => { const proc = fakeProcess(); proc.pid = undefined; setImmediate(() => proc.emit('error', Object.assign(new Error(`ENOENT ${SECRET}`), { code: 'ENOENT' }))); return proc; };
  assert.deepEqual(await child.spawnChild(submitRequest(), { env: {}, spawn }), { ok: false, started: false, why: 'spawn' });
});

test('a quote or status child that takes too long is stopped; a submit child is never stopped and never timed out', { timeout: 30000 }, async () => {
  // Status: the limit passes, the child is killed, the answer is a timeout.
  let { spawn, calls } = fakeSpawn();
  assert.deepEqual(await child.spawnChild(statusRequest, { env: {}, spawn, timeoutMs: 20 }), { ok: false, started: true, why: 'timeout' });
  assert.equal(calls[0].proc.kills, 1);
  // A late end of that child changes nothing.
  calls[0].proc.answer('', 1);

  // Submit: the same limit is ignored. It is still waiting long after, and was not killed.
  ({ spawn, calls } = fakeSpawn());
  let settled = null;
  const waiting = child.spawnChild(submitRequest(), { env: {}, spawn, timeoutMs: 20 }).then((value) => { settled = value; });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(settled, null, 'a submit is not timed out');
  assert.equal(calls[0].proc.kills, 0);
  calls[0].proc.answer(`${JSON.stringify({ v: 1, kind: 'submit', ok: true, state: 'submitted', jobId: 'job-7', status: 'scheduled', recorded: true })}\n`);
  await waiting;
  assert.equal(settled.ok, true);
  assert.equal(calls[0].proc.kills, 0);
});

test('when the client has gone, the gateway stops waiting: a submit child is left to finish, a quote or status child is stopped', { timeout: 30000 }, async () => {
  // Submit: abandoned, not killed; it can still finish on its own.
  let { spawn, calls } = fakeSpawn();
  let controller = new AbortController();
  let waiting = child.spawnChild(submitRequest(), { env: {}, spawn, signal: controller.signal });
  controller.abort();
  assert.deepEqual(await waiting, { ok: false, started: true, why: 'abandoned' });
  assert.equal(calls[0].proc.kills, 0);
  assert.equal(calls[0].proc.unrefs, 1, 'it no longer keeps the gateway process alive');
  calls[0].proc.answer(`${JSON.stringify({ v: 1, kind: 'submit', ok: true, state: 'submitted', jobId: 'job-7', status: 'scheduled', recorded: true })}\n`);
  assert.equal(calls[0].proc.kills, 0);

  // Already gone before the start: nothing is started, so nothing is sent.
  ({ spawn, calls } = fakeSpawn());
  controller = new AbortController();
  controller.abort();
  assert.deepEqual(await child.spawnChild(submitRequest(), { env: {}, spawn, signal: controller.signal }), { ok: false, started: false, why: 'abandoned' });
  assert.equal(calls.length, 0);

  // Status: stopped.
  ({ spawn, calls } = fakeSpawn());
  controller = new AbortController();
  waiting = child.spawnChild(statusRequest, { env: {}, spawn, signal: controller.signal });
  controller.abort();
  assert.deepEqual(await waiting, { ok: false, started: true, why: 'abandoned' });
  assert.equal(calls[0].proc.kills, 1);

  // Status, already gone before the start: nothing is started.
  ({ spawn, calls } = fakeSpawn());
  assert.deepEqual(await child.spawnChild(statusRequest, { env: {}, spawn, signal: controller.signal }), { ok: false, started: false, why: 'abandoned' });
  assert.equal(calls.length, 0);
});

test('a real process: the child sees only the listed environment names, and its one line comes back', async (t) => {
  const home = tempDir(t);
  // A stand-in for the child script: the real child code with a stub in place
  // of the video command. It records what it was given and answers a job.
  const stub = path.join(home, 'stub-child.js');
  fs.writeFileSync(stub, `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const child = require(${JSON.stringify(CHILD_FILE)});
child.start({ run: async (args, out, options) => {
  fs.writeFileSync(path.join(process.env.DSHPROXY_HOME, 'seen.json'), JSON.stringify({ env: process.env, args, sameEnv: options.env === process.env, argv: process.argv.slice(2) }));
  out(JSON.stringify({ model: args[1], route: args[2], id: args[3], status: 'processing', note: ${JSON.stringify(SECRET)} }, null, 2));
} }).then((code) => { process.exitCode = code; });
`);
  const env = parentEnv({ TEMP: home, TMP: home, USERPROFILE: home, LOCALAPPDATA: home, APPDATA: home, DSHPROXY_HOME: 'C:\\not-this-one' });
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot; else delete env.SystemRoot;
  const answer = await child.spawnChild(statusRequest, { execPath: process.execPath, script: stub, env, home, timeoutMs: 60000 });
  assert.deepEqual(answer, { ok: true, started: true, result: { v: 1, kind: 'status', ok: true, jobId: 'job-7', status: 'processing' } });
  const seen = JSON.parse(fs.readFileSync(path.join(home, 'seen.json'), 'utf8'));
  assert.deepEqual(seen.args, statusRequest.args);
  assert.equal(seen.sameEnv, true);
  assert.deepEqual(seen.argv, [], 'nothing of the request is on the command line');
  // Windows itself adds a few names to every process started by Node; none of them is a secret.
  const ADDED_BY_THE_SYSTEM = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR', '__CF_USER_TEXT_ENCODING'];
  const allowed = new Set([...LISTED, ...KEYS, ...ADDED_BY_THE_SYSTEM].map((name) => name.toUpperCase()));
  const names = Object.keys(seen.env);
  for (const name of names) assert.ok(allowed.has(name.toUpperCase()), `the child was given ${name}`);
  const upper = names.map((name) => name.toUpperCase());
  for (const name of [...LISTED, ...KEYS].filter((listed) => env[listed] !== undefined)) assert.ok(upper.includes(name.toUpperCase()), `the child was not given ${name}`);
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DSHPROXY_API_KEY', 'DSH_HOME', 'KREA_API_TOKEN', 'PICKER_EDGE_PLANTED', 'NODE_TEST_CONTEXT']) {
    assert.equal(upper.includes(name), false, name);
  }
  assert.equal(seen.env.DSHPROXY_HOME, home);
  assert.equal(seen.env.KOVAPI_API_KEY, 'synthetic-KOVAPI_API_KEY');
  assert.equal(JSON.stringify(seen.env).includes('PLANTED'), false);
  assert.equal(JSON.stringify(answer).includes('PLANTED'), false);
});

test('a real process that exits without a line, or cannot be found, is a failure without text', async (t) => {
  const home = tempDir(t);
  const silent = path.join(home, 'silent.js');
  fs.writeFileSync(silent, `process.stderr.write(${JSON.stringify(SECRET)}); process.exitCode = 3;\n`);
  const env = process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
  assert.deepEqual(await child.spawnChild(statusRequest, { script: silent, env, home, timeoutMs: 60000 }), { ok: false, started: true, why: 'exit' });
  assert.deepEqual(await child.spawnChild(statusRequest, { execPath: path.join(home, 'no-such-node.exe'), script: silent, env, home, timeoutMs: 60000 }), { ok: false, started: false, why: 'spawn' });
});
