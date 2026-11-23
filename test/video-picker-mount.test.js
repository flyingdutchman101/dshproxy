'use strict';
// Putting the picker in front of a server's own request listener. The server
// here is a plain one whose own listener answers `forwarded`.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const picker = require('../src/video/picker/http');

const VIDEO = '/dshproxy/video/v1/messages';
const SECRET = 'sk-PLANTED.secret/0123456789+abcdef=';

// The server's own listener: answers `forwarded` and echoes the body it read,
// and records what it was called with.
function plainServer() {
  const seen = [];
  const own = function (req, res) {
    seen.push({ self: this, req, res });
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`forwarded ${req.method} ${req.url} ${Buffer.concat(chunks).toString('utf8')}`);
    });
  };
  const server = http.createServer(own);
  return { server, own, seen };
}

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

function send(port, { method = 'POST', path = VIDEO, body = '{}', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : body);
  });
}

const answers = (text) => (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(text); };

test('a request for another path reaches the server\'s own listener with the same objects, and nothing was read from it first', () => {
  const { server, seen } = plainServer();
  let pickerCalls = 0;
  picker.mount(server, { handler: () => { pickerCalls += 1; }, claims: picker.claims });
  assert.equal(server.listenerCount('request'), 1);
  for (const url of ['/v1/messages', '/v1/chat/completions', '/dshproxy/status', '/dshproxy/control/stop', '/dshproxy/video', '/', '/v1/models?x=/dshproxy/video/']) {
    const read = [];
    const record = (list, target) => new Proxy(target, {
      get(object, name) { list.push(String(name)); return object[name]; },
      set(object, name) { list.push(`set ${String(name)}`); return true; },
      has(object, name) { list.push(`has ${String(name)}`); return name in object; },
      ownKeys(object) { list.push('keys'); return Reflect.ownKeys(object); },
    });
    const touched = [];
    // The own listener of this test only records; it must find untouched objects.
    const req = record(read, { url, method: 'POST', headers: { host: 'x' }, on() {}, once() {} });
    const res = record(touched, { writeHead() {}, end() {}, on() {} });
    const before = seen.length;
    const snapshot = [];
    seen.push = function (item) { snapshot.push([...read], [...touched]); return Array.prototype.push.call(this, item); };
    server.emit('request', req, res);
    delete seen.push;
    assert.equal(seen.length, before + 1, url);
    const call = seen.at(-1);
    assert.equal(call.self, server, 'the same this');
    assert.equal(call.req, req, 'the same request');
    assert.equal(call.res, res, 'the same response');
    // By the time the own listener ran, the picker had read the address and nothing else.
    assert.deepEqual([...new Set(snapshot[0])], ['url'], url);
    assert.deepEqual(snapshot[1], [], url);
  }
  assert.equal(pickerCalls, 0);
});

test('over HTTP, other paths are answered by the server as before, with their bodies whole, and the video path by the picker', async (t) => {
  const { server, seen } = plainServer();
  const mine = [];
  picker.mount(server, { handler: (req, res) => { mine.push(req.url); answers('picked')(req, res); } });
  const port = await listen(t, server);
  const body = JSON.stringify({ model: 'gpt', messages: [{ role: 'user', content: 'x'.repeat(100000) }] });
  const chatReply = await send(port, { path: '/v1/messages', body });
  assert.equal(chatReply.text, `forwarded POST /v1/messages ${body}`);
  assert.equal((await send(port, { method: 'GET', path: '/dshproxy/status' })).text, 'forwarded GET /dshproxy/status ');
  assert.equal((await send(port, { path: '/dshproxy/video', body: 'b' })).text, 'forwarded POST /dshproxy/video b');
  assert.equal((await send(port)).text, 'picked');
  assert.equal((await send(port, { method: 'GET', path: '/dshproxy/video/v1/models' })).text, 'picked');
  assert.deepEqual(mine, [VIDEO, '/dshproxy/video/v1/models']);
  assert.equal(seen.length, 3, 'the server\'s own listener never saw a video request');
});

test('a listener added later, such as a request counter, still runs for every request', async (t) => {
  const { server } = plainServer();
  picker.mount(server, { handler: answers('picked') });
  const counted = [];
  server.prependListener('request', (req) => counted.push(req.url));
  const port = await listen(t, server);
  await send(port, { path: '/v1/messages' });
  await send(port);
  assert.deepEqual(counted, ['/v1/messages', VIDEO]);
});

test('a server with no request listener, or with two, is refused at mount and left as it was', () => {
  const none = http.createServer();
  assert.throws(() => picker.mount(none, { handler: () => {} }), /must be mounted before anything else listens for requests/);
  assert.equal(none.listenerCount('request'), 0);
  const { server, own } = plainServer();
  const second = () => {};
  server.on('request', second);
  assert.throws(() => picker.mount(server, { handler: () => {} }), /must be mounted before anything else listens for requests/);
  assert.deepEqual(server.listeners('request'), [own, second]);
  // After a counter was prepended, as the gateway does later, it is too late.
  const { server: counted } = plainServer();
  counted.prependListener('request', () => {});
  assert.throws(() => picker.mount(counted, { handler: () => {} }), /must be mounted before anything else listens for requests/);
  assert.equal(counted.listenerCount('request'), 2);
});

test('with no handler, the video path is answered 503 and never reaches the server\'s own listener; everything else is forwarded', async (t) => {
  for (const handler of [null, undefined]) {
    const { server, seen } = plainServer();
    const log = [];
    picker.mount(server, { handler, log: (line) => log.push(line) });
    const port = await listen(t, server);
    for (const request of [{}, { method: 'GET', path: '/dshproxy/video/v1/models' }, { path: `/dshproxy/video/${encodeURIComponent(SECRET)}`, body: SECRET }]) {
      const response = await send(port, request);
      assert.equal(response.status, 503);
      assert.match(response.headers['content-type'], /^application\/json/);
      const value = JSON.parse(response.text);
      assert.equal(value.type, 'error');
      assert.equal(typeof value.error.message, 'string');
      assert.equal(response.text.includes('PLANTED'), false);
    }
    assert.equal(seen.length, 0);
    assert.equal((await send(port, { path: '/v1/messages', body: 'b' })).text, 'forwarded POST /v1/messages b');
    assert.equal(log.join('\n').includes('PLANTED'), false);
  }
});

test('a handler that throws, or whose promise rejects, leaves the server alive and answers a short error', async (t) => {
  const { server } = plainServer();
  const log = [];
  let mode = 'throw';
  picker.mount(server, { log: (line) => log.push(line), handler: (req, res) => {
    if (mode === 'throw') throw new RangeError(`sync ${SECRET}`);
    if (mode === 'reject') return Promise.reject(new TypeError(`async ${SECRET}`));
    if (mode === 'reject-odd') return Promise.reject(SECRET);
    if (mode === 'after-headers') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: message_start\n\n'); throw new EvalError(`late ${SECRET}`); }
    return answers('picked')(req, res);
  } });
  const port = await listen(t, server);
  for (const [name, className] of [['throw', 'RangeError'], ['reject', 'TypeError'], ['reject-odd', null]]) {
    mode = name;
    const response = await send(port);
    assert.equal(response.status, 500, name);
    assert.equal(JSON.parse(response.text).type, 'error');
    assert.equal(response.text.includes('PLANTED'), false);
    assert.match(log.at(-1), /^video picker: /);
    if (className) assert.ok(log.at(-1).includes(className), log.at(-1));
    // Chat is untouched in between.
    assert.equal((await send(port, { path: '/v1/messages', body: name })).text, `forwarded POST /v1/messages ${name}`);
  }
  // Headers already sent: nothing more can be said, so the response is ended.
  mode = 'after-headers';
  const cut = await send(port);
  assert.equal(cut.status, 200);
  assert.equal(cut.text, 'event: message_start\n\n');
  assert.ok(log.at(-1).includes('EvalError'));
  assert.equal(log.join('\n').includes('PLANTED'), false);
  assert.equal(log.length, 4);
  mode = 'fine';
  assert.equal((await send(port)).text, 'picked');
  assert.equal((await send(port, { path: '/v1/messages', body: 'still' })).text, 'forwarded POST /v1/messages still');
});

test('a claims function that throws sends the request to the server\'s own listener, never to the picker', async (t) => {
  const { server } = plainServer();
  let picked = 0;
  picker.mount(server, { handler: () => { picked += 1; }, claims: () => { throw new Error('broken'); } });
  const port = await listen(t, server);
  assert.equal((await send(port, { path: '/v1/messages', body: 'b' })).text, 'forwarded POST /v1/messages b');
  assert.equal(picked, 0);
});

test('mounted in front of the real handler, a whole video request is answered and chat is forwarded', async (t) => {
  const { server, seen } = plainServer();
  const port = await listen(t, server);
  picker.mount(server, { handler: picker.handler({ origin: `http://127.0.0.1:${port}`,
    answer: async (body, write) => { write(`quote for ${body.messages.at(-1).content}`); } }) });
  const response = await send(port, { body: JSON.stringify({ model: 'seedance-2.5/720p/krea', stream: true, messages: [{ role: 'user', content: 'a red ball' }] }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream');
  assert.ok(response.text.includes('"text":"quote for a red ball"'));
  assert.equal(seen.length, 0);
  assert.equal((await send(port, { path: '/v1/messages', body: 'chat' })).text, 'forwarded POST /v1/messages chat');
});
