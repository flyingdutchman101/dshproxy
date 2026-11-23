'use strict';
require("./support/keychain"); // on macOS: a throwaway keychain for this file and its children, never a login Keychain
// The video picker as the gateway runs it: the real decision logic, the real
// entry list from the video settings, the real ops and the real child code,
// joined. The one thing replaced is the start of a process: the stand-in runs
// the child's own main() in this process with a video command that answers
// from a script. No provider, no network, no credential.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const guard = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-picker-wired-guard-'));
process.env.DSHPROXY_HOME = guard;
process.env.DSH_HOME = path.join(guard, 'no-deepseek-harness');
globalThis.fetch = () => { throw new Error('network is forbidden in this test'); };
after(() => {
  try { assert.deepEqual(fs.readdirSync(guard), []); } finally { fs.rmSync(guard, { recursive: true, force: true }); }
});

const picker = require('../src/video/picker');
const child = require('../src/video/picker/child');
const catalog = require('../src/video/catalog');
const video = require('../src/video/settings');
const { run: command } = require('../src/video/command');
const { virtualClock, ask, request, PROMPT, HOUR } = require('./video-picker-world');

const KREA = 'seedance-2.5/720p/krea';
const DOLLARS = 'wan-3.0/1080p/videorouter';
const KOVAPI = 'minimax-h3/768p/kovapi';
const CALLIRRA = 'minimax-h3/768p/callirra';
const NAMES = {
  [KREA]: { model: 'seedance-2.5', resolution: '720p', route: 'krea' },
  [DOLLARS]: { model: 'wan-3.0', resolution: '1080p', route: 'videorouter' },
  [KOVAPI]: { model: 'minimax-h3', resolution: '768p', route: 'kovapi' },
  [CALLIRRA]: { model: 'minimax-h3', resolution: '768p', route: 'callirra' }
};

// A data folder with the four entries switched on, purchases from chat on (or
// as asked), and a picker wired as the gateway wires it.
async function wired(t, { purchases = true, settings = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-picker-wired-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const name of Object.values(NAMES)) await video.setEntry(home, name, true);
  if (settings) {
    fs.mkdirSync(path.join(home, 'video-picker'), { recursive: true });
    fs.writeFileSync(path.join(home, 'video-picker', 'settings.json'), JSON.stringify({ purchases, ceiling: { clips: 10, krea_units: 15000, usd_micros: 20000000, callirra_credits: 2000 } }));
  }
  const w = { home, logs: [], ran: [], starts: [], plan: {}, statusOf: {} };
  // The video command, as the child calls it: one call per child.
  const run = async (args, out) => {
    w.ran.push(args);
    const [kind, model, route] = args;
    if (kind === 'quote' && route === 'krea') return out(JSON.stringify({ model, route, mode: 'preflight', compute_units: 856, is_estimated: false, available_compute_units: 97909.73, affordable: true, currency: 'workspace_compute_units', budgetFlag: '--max-units' }));
    // A published price: the real command, which reads the catalog and asks nobody.
    if (kind === 'quote') return command(args, out, { env: { DSHPROXY_HOME: home } });
    if (kind === 'submit') {
      if (w.plan.submit instanceof Error) throw w.plan.submit;
      return out(JSON.stringify({ model, route, id: 'job-7', status: route === 'krea' ? 'scheduled' : 'queued' }));
    }
    return out(JSON.stringify({ model, route, id: args[3], status: w.statusOf[route] || 'completed', outputUrl: 'https://clips.example/job-7.mp4' }));
  };
  // In place of starting a process: the same checks on the request, then the child's own main().
  const spawnChild = async (order, options) => {
    w.starts.push({ kind: order.kind, options });
    if (w.plan.start === 'spawn' && order.kind === 'submit') return { ok: false, started: false, why: 'spawn' };
    const parsed = child.parseRequest(JSON.stringify(order));
    if (parsed === null) return { ok: false, started: false, why: 'request' };
    if (w.plan.start === 'dies' && order.kind === 'submit') return { ok: false, started: true, why: 'exit' };
    let line = null;
    const code = await child.main(parsed, { run, print: (text) => { line = text; } });
    return code === 0 && line !== null ? { ok: true, started: true, result: JSON.parse(line) } : { ok: false, started: true, why: 'exit' };
  };
  w.clock = virtualClock();
  w.clock.time = Date.now();
  w.options = { home, spawnChild, exposed: () => false, clock: w.clock, log: (line) => { w.logs.push(line); } };
  w.picker = picker.wired(w.options);
  const journal = path.join(home, 'video-picker', 'claims.log');
  w.clock.time = Math.max(Math.ceil(fs.statSync(journal).birthtimeMs), JSON.parse(fs.readFileSync(journal, 'utf8').split('\n')[0]).createdAt) + HOUR;
  w.submits = () => w.ran.filter((args) => args[0] === 'submit');
  w.outcome = (id) => JSON.parse(fs.readFileSync(path.join(home, 'video-picker', 'outcomes', `${id}.json`), 'utf8'));
  return w;
}

async function quoteFor(w, model, prompt = PROMPT) {
  const text = await ask(w, request(model, [['user', prompt]]), w.picker);
  const found = /\nQuote (Q-[A-Z2-9]{16})$/.exec(text);
  assert.ok(found, `not a quote: ${text}`);
  return { id: found[1], text, model, turns: [['user', prompt], ['assistant', text]] };
}
const yes = (quote) => request(quote.model, [...quote.turns, ['user', 'yes']]);

test('a Krea entry: the live preflight is the quote, one yes is one submit with that cap, and a repeat reports the same job', async (t) => {
  const w = await wired(t);
  const quote = await quoteFor(w, KREA);
  assert.match(quote.text, /Seedance 2\.5 - 720p - Krea/);
  assert.match(quote.text, /at most 856 Krea compute units/);
  assert.deepEqual(w.ran, [['quote', 'seedance-2.5', 'krea', '--resolution', '720p', '--prompt', PROMPT]]);

  const bought = await ask(w, yes(quote), w.picker);
  assert.deepEqual(w.submits(), [['submit', 'seedance-2.5', 'krea', '--max-units', '856', '--confirm-charge', '--resolution', '720p', PROMPT]]);
  assert.match(bought, /Job job-7/);
  assert.match(bought, /\[Open the clip\]\(https:\/\/clips\.example\/job-7\.mp4\)/);
  assert.match(bought, new RegExp(`Finished ${quote.id}$`));
  // The child wrote the outcome, with the nonce of the claim in the journal.
  const claim = fs.readFileSync(path.join(w.home, 'video-picker', 'claims.log'), 'utf8').split('\n').filter((line) => line.includes(quote.id)).map((line) => JSON.parse(line));
  assert.equal(claim.length, 1);
  assert.deepEqual(w.outcome(quote.id), { nonce: claim[0].nonce, state: 'submitted', jobId: 'job-7', status: 'scheduled' });
  // Every child works in the gateway's data folder; a submit has no time limit.
  assert.ok(w.starts.every((start) => start.options.home === w.home));
  assert.deepEqual(w.starts.filter((start) => start.kind === 'submit').map((start) => Object.keys(start.options)), [['home']]);

  // The same request again, from a picker made anew: the job, and no second submit.
  const again = await ask(w, yes(quote), picker.wired(w.options));
  assert.equal(w.submits().length, 1);
  assert.match(again, /job-7/);
});

test('a dollar entry: the quote is the published price and says nobody checked it, and the cap sent is that price', async (t) => {
  const w = await wired(t);
  const price = catalog.quote('wan-3.0', 'videorouter', '1080p');
  const quote = await quoteFor(w, DOLLARS);
  assert.match(quote.text, /Wan 3\.0 - 1080p - VideoRouter/);
  assert.match(quote.text, /published price/);
  assert.ok(quote.text.includes(price.verifiedOn), 'the date of the price is shown');
  assert.deepEqual(w.ran, [['quote', 'wan-3.0', 'videorouter', '--resolution', '1080p']], 'no prompt goes into a published-price quote');

  await ask(w, yes(quote), w.picker);
  const [sent] = w.submits();
  assert.equal(w.submits().length, 1);
  assert.deepEqual([sent[0], sent[1], sent[2], sent[3], sent[5], sent[6], sent[7], sent[8]], ['submit', 'wan-3.0', 'videorouter', '--max-usd', '--confirm-charge', '--resolution', '1080p', PROMPT]);
  assert.equal(Math.round(Number(sent[4]) * 1e6), price.usdMicros, 'the cap is the quoted price, in dollars');
});

test('a Callirra entry is capped in credits', async (t) => {
  const w = await wired(t);
  const quote = await quoteFor(w, CALLIRRA);
  assert.match(quote.text, /10 Callirra credits/);
  await ask(w, yes(quote), w.picker);
  assert.deepEqual(w.submits(), [['submit', 'minimax-h3', 'callirra', '--max-credits', '10', '--confirm-charge', '--resolution', '768p', PROMPT]]);
});

test('a child that could not be started sent nothing: the answer says so, and the quote is still spent', async (t) => {
  const w = await wired(t);
  const quote = await quoteFor(w, KREA);
  w.plan.start = 'spawn';
  const text = await ask(w, yes(quote), w.picker);
  assert.match(text, new RegExp(`Nothing was bought with quote ${quote.id}`));
  assert.doesNotMatch(text, /I do not know/);
  assert.equal(w.outcome(quote.id).state, 'not-sent');
  assert.equal(w.submits().length, 0);

  w.plan.start = null;
  const again = await ask(w, yes(quote), w.picker);
  assert.match(again, /Nothing was bought/);
  assert.equal(w.submits().length, 0, 'a quote is used once, whatever became of it');
  assert.equal(w.starts.filter((start) => start.kind === 'submit').length, 1);
});

test('a child that ran and left no outcome: nobody knows, and nothing is sent again', async (t) => {
  const w = await wired(t);
  const quote = await quoteFor(w, KREA);
  w.plan.start = 'dies';
  const text = await ask(w, yes(quote), w.picker);
  assert.match(text, /I do not know whether this clip was bought\./);
  w.plan.start = null;
  const again = await ask(w, yes(quote), picker.wired(w.options));
  assert.match(again, /I do not know whether this clip was bought\./);
  assert.equal(w.starts.filter((start) => start.kind === 'submit').length, 1);
  assert.equal(w.submits().length, 0);
});

test('a refusal the command gives before any request is "not sent", with its reason, from the real sentences', async (t) => {
  const w = await wired(t);
  const quote = await quoteFor(w, KREA);
  w.plan.submit = new Error('Krea workspace sign-in required. Run the Krea sign-in, then try again.');
  const text = await ask(w, yes(quote), w.picker);
  assert.match(text, new RegExp(`Nothing was bought with quote ${quote.id}`));
  assert.deepEqual([w.outcome(quote.id).state, w.outcome(quote.id).reason], ['not-sent', 'sign-in']);
  assert.ok(!text.includes('Run the Krea sign-in, then try again.'), 'no text of an error is shown');
});

test('an entry switched off after its quote does not buy; switched on again, the same reply still can', async (t) => {
  const w = await wired(t);
  const quote = await quoteFor(w, KREA);
  await video.setEntry(w.home, NAMES[KREA], false);
  const text = await ask(w, yes(quote), w.picker);
  assert.match(text, /This video entry is switched off in DSHProxy\./);
  assert.equal(w.starts.filter((start) => start.kind === 'submit').length, 0);
  await video.setEntry(w.home, NAMES[KREA], true);
  await ask(w, yes(quote), w.picker);
  assert.equal(w.submits().length, 1);
});

test('providers name the end of a job differently: "succeeded" is completed, "expired" is failed', async (t) => {
  const w = await wired(t);
  w.statusOf.kovapi = 'succeeded';
  let quote = await quoteFor(w, KOVAPI);
  let text = await ask(w, yes(quote), w.picker);
  assert.match(text, /\[Open the clip\]\(https:\/\/clips\.example\/job-7\.mp4\)/);

  w.statusOf.callirra = 'expired';
  quote = await quoteFor(w, CALLIRRA, 'A blue kite over a field');
  text = await ask(w, yes(quote), w.picker);
  assert.match(text, /The job failed/);
  assert.doesNotMatch(text, /Open the clip/);
});

test('without a settings file purchases from chat are off: a yes rehearses and no purchase is started', async (t) => {
  const w = await wired(t, { settings: false });
  const quote = await quoteFor(w, KREA);
  const text = await ask(w, yes(quote), w.picker);
  assert.match(text, /Rehearsal: nothing was bought\./);
  assert.equal(w.starts.filter((start) => start.kind === 'submit').length, 0);
  assert.equal(w.outcome(quote.id).state, 'rehearsal');
});

test('when the client goes away while a job is followed, the following stops: no more status checks, and the job stays as it is', async (t) => {
  const w = await wired(t);
  w.statusOf.krea = 'processing';
  const quote = await quoteFor(w, KREA);
  const client = new AbortController();
  const statusCalls = () => w.ran.filter((args) => args[0] === 'status').length;
  let text = '';
  const started = w.clock.now();
  // As the HTTP layer calls it: the signal aborts when the connection closes.
  await w.picker.answer(yes(quote), (piece) => {
    text += piece;
    if (text.includes('Generating')) client.abort();
    return true;
  }, { signal: client.signal });
  assert.equal(w.submits().length, 1, 'the clip was ordered once');
  assert.ok(statusCalls() <= 1, `${statusCalls()} status checks after the client left`);
  assert.ok(w.clock.now() - started < 60000, `still following ${Math.round((w.clock.now() - started) / 1000)} s after the client left`);
  assert.doesNotMatch(text, /Still running after 12 minutes/);

  // The next message finds the job; nothing is ordered again.
  w.statusOf.krea = 'completed';
  const next = await ask(w, yes(quote), w.picker);
  assert.match(next, /\[Open the clip\]/);
  assert.equal(w.submits().length, 1);
});

test('a client that is gone before the purchase is recorded buys nothing, and the quote is still open', async (t) => {
  const w = await wired(t);
  const quote = await quoteFor(w, KREA);
  const journal = () => fs.readFileSync(path.join(w.home, 'video-picker', 'claims.log'), 'utf8');
  const before = journal();
  const client = new AbortController();
  client.abort();
  await w.picker.answer(yes(quote), () => true, { signal: client.signal });
  assert.equal(w.starts.filter((start) => start.kind === 'submit').length, 0, 'no purchase was started');
  assert.equal(journal(), before, 'the quote was not claimed');

  // The same reply from a client that stays buys once.
  const text = await ask(w, yes(quote), w.picker);
  assert.match(text, /\[Open the clip\]/);
  assert.equal(w.submits().length, 1);
});

// ------------------------------- over HTTP, mounted on a server -------------------------------

function post(port, target, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: target, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers }, agent: false }, (res) => {
      let got = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { got += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text: got }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(text);
  });
}
// The text of an Anthropic event stream: its text deltas, joined.
const spoken = (stream) => stream.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
  .filter((event) => event.type === 'content_block_delta').map((event) => event.delta.text).join('');

test('mounted on a server: a quote read off the event stream, replayed word for word, buys once; chat requests pass by untouched', async (t) => {
  const w = await wired(t);
  const forwarded = [];
  const server = http.createServer((req, res) => {
    forwarded.push(req.url);
    req.resume();
    req.on('end', () => res.end('forwarded'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address();
  picker.mount(server, { ...w.options, origin: `http://127.0.0.1:${port}` });

  const first = await post(port, '/dshproxy/video/v1/messages', request(KREA, [['user', PROMPT]]));
  assert.deepEqual([first.status, first.type], [200, 'text/event-stream']);
  const quote = spoken(first.text);
  const id = /\nQuote (Q-[A-Z2-9]{16})$/.exec(quote);
  assert.ok(id, `not a quote: ${quote}`);

  const second = await post(port, '/dshproxy/video/v1/messages', request(KREA, [['user', PROMPT], ['assistant', quote], ['user', 'yes']]));
  assert.match(spoken(second.text), /\[Open the clip\]\(https:\/\/clips\.example\/job-7\.mp4\)/);
  assert.equal(w.submits().length, 1);

  // Not the picker's: a web page's request, and everything on another path.
  const page = await post(port, '/dshproxy/video/v1/messages', request(KREA, [['user', PROMPT]]), { origin: 'https://example.com' });
  assert.equal(page.status, 403);
  const chat = await post(port, '/v1/messages', { model: 'lane-main', messages: [] });
  assert.deepEqual([chat.status, chat.text], [200, 'forwarded']);
  assert.deepEqual(forwarded, ['/v1/messages'], 'no video request reached the chat handler');
  assert.ok(!w.logs.join('\n').includes(PROMPT), 'no prompt in the log');
});

test('mounted without a data folder it can use: the video path answers 503 and chat is served as before', async (t) => {
  const server = http.createServer((req, res) => res.end('forwarded'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address();
  const logs = [];
  // A file where the folder should be.
  const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-picker-wired-')), 'not-a-folder');
  t.after(() => fs.rmSync(path.dirname(blocked), { recursive: true, force: true }));
  fs.writeFileSync(blocked, 'x');
  picker.mount(server, { home: blocked, origin: `http://127.0.0.1:${port}`, log: (line) => logs.push(line), exposed: () => false });

  const video503 = await post(port, '/dshproxy/video/v1/messages', request(KREA, [['user', PROMPT]]));
  assert.equal(video503.status, 503);
  const chat = await post(port, '/v1/messages', { model: 'lane-main', messages: [] });
  assert.deepEqual([chat.status, chat.text], [200, 'forwarded']);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes(blocked), 'the log line names no path');
});

test('dshproxy video picker is handed to the picker command', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshproxy-picker-wired-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const lines = [];
  await command(['picker'], (line) => lines.push(line), { env: { DSHPROXY_HOME: home } });
  const shown = JSON.parse(lines.join('\n'));
  assert.equal(shown.purchases, 'off');
  assert.equal(shown.ceiling_per_24_hours.clips, 10);
  await command(['picker', 'purchases', 'on'], () => {}, { env: { DSHPROXY_HOME: home } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'video-picker', 'settings.json'), 'utf8')).purchases, true);
  const help = [];
  await command(['help'], (line) => help.push(line), { env: { DSHPROXY_HOME: home } });
  assert.match(help.join('\n'), /video picker/);
});
