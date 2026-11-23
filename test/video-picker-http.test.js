'use strict';
// The HTTP side of the video picker on a plain server on port 0, with a fake
// `answer`. Nothing here knows about quotes, purchases or providers.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const picker = require('../src/video/picker/http');

const PATH = '/dshproxy/video/v1/messages';
const FAILED = 'Something went wrong inside DSHProxy; nothing further was sent.';
const SECRET = 'sk-PLANTED.secret/0123456789+abcdef=';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// A server whose only listener is the picker's handler. `answer` can be
// replaced per test; `watch(req, res)` runs before the handler.
async function serve(t, { answer = async () => {}, maxBytes, watch = () => {}, hostPort } = {}) {
  const state = { answer, calls: [], log: [], settled: [] };
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const handle = picker.handler({
    answer: (...args) => { state.calls.push(args); return state.answer(...args); },
    origin: `http://127.0.0.1:${hostPort || port}`,
    log: (line) => state.log.push(line),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  server.on('request', (req, res) => {
    watch(req, res);
    const result = handle(req, res);
    if (watch.after) watch.after();
    state.settled.push(result);
  });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return Object.assign(state, { server, port });
}

// One request; resolves with the status, headers and whole body.
function send(port, { method = 'POST', path = PATH, headers = {}, body, json } = {}) {
  const payload = json === undefined ? body : JSON.stringify(json);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false,
      headers: { 'content-type': 'application/json', ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const chat = (extra = {}) => ({ model: 'seedance-2.5/720p/krea', stream: true, messages: [{ role: 'user', content: 'A red ball' }], ...extra });

// The events of a stream, as [event name, parsed data].
function events(text) {
  return text.split('\n\n').filter(Boolean).map((frame) => {
    const lines = frame.split('\n');
    assert.equal(lines.length, 2, `a frame is an event line and a data line: ${JSON.stringify(frame)}`);
    assert.ok(lines[0].startsWith('event: '));
    assert.ok(lines[1].startsWith('data: '));
    return [lines[0].slice(7), JSON.parse(lines[1].slice(6))];
  });
}
const deltas = (text) => events(text).filter(([name]) => name === 'content_block_delta').map(([, data]) => data.delta.text);

function errorOf(response) {
  assert.match(response.headers['content-type'], /^application\/json/);
  const value = JSON.parse(response.text);
  assert.equal(value.type, 'error');
  assert.equal(typeof value.error.type, 'string');
  assert.equal(typeof value.error.message, 'string');
  assert.ok(response.text.length < 400, 'a short error');
  return value.error;
}

// What a handler did to a request's body while it was being called.
function bodySpy() {
  const seen = [];
  const watch = (req) => {
    for (const name of ['on', 'once', 'addListener', 'prependListener']) {
      const real = req[name];
      req[name] = function (event, ...rest) {
        if (watch.active && ['data', 'readable', 'end'].includes(event)) seen.push(`${name}:${event}`);
        return real.call(this, event, ...rest);
      };
    }
    for (const name of ['read', 'resume', 'pipe', Symbol.asyncIterator]) {
      const real = req[name];
      req[name] = function (...args) {
        if (watch.active) seen.push(String(name));
        return real.apply(this, args);
      };
    }
    watch.active = true;
  };
  // The handler refuses at the door before it returns. What Node itself does
  // with the unread body once the answer has gone out is not the handler's doing.
  watch.after = () => { watch.active = false; };
  return { seen, watch };
}

test('claims() is true for the video path and reads nothing but the address', () => {
  const read = [];
  const req = (url) => new Proxy({ url }, { get(target, name) { read.push(name); return target[name]; } });
  assert.equal(picker.claims(req('/dshproxy/video/v1/messages')), true);
  assert.equal(picker.claims(req('/dshproxy/video/')), true);
  assert.equal(picker.claims(req('/dshproxy/video/anything?x=1')), true);
  for (const url of ['/dshproxy/video', '/dshproxy/videos/v1/messages', '/v1/messages', '/dshproxy/status', '/dshproxy/control/x', 'http://127.0.0.1/dshproxy/video/v1/messages', '', undefined]) {
    assert.equal(picker.claims(req(url)), false, String(url));
  }
  assert.deepEqual([...new Set(read)], ['url']);
});

test('everything that is not a chat request for this route is refused at the door, before the body is read', async (t) => {
  const spy = bodySpy();
  const s = await serve(t, { watch: spy.watch });
  const own = `127.0.0.1:${s.port}`;
  const body = JSON.stringify(chat());
  const refusals = [
    ['a GET', { method: 'GET', body: undefined }, 404],
    ['a PUT', { method: 'PUT', body }, 404],
    ['a DELETE', { method: 'DELETE', body: undefined }, 404],
    ['a model listing', { method: 'GET', path: '/dshproxy/video/v1/models', body: undefined }, 404],
    ['another path', { path: '/dshproxy/video/v1/messages/batches', body }, 404],
    ['a longer path', { path: '/dshproxy/video/v1/messages/', body }, 404],
    ['the folder itself', { path: '/dshproxy/video/', body }, 404],
    ['count_tokens', { path: '/dshproxy/video/v1/messages/count_tokens', body }, 404],
    ['an Origin header', { headers: { origin: `http://${own}` }, body }, 403],
    ['an Origin header of a web page', { headers: { origin: 'https://example.com' }, body }, 403],
    ['an empty Origin header', { headers: { origin: '' }, body }, 403],
    ['another host name', { headers: { host: `example.com:${s.port}` }, body }, 403],
    ['the right name on another port', { headers: { host: '127.0.0.1:1' }, body }, 403],
    ['the right name without a port', { headers: { host: '127.0.0.1' }, body }, 403],
    ['another loopback name', { headers: { host: `[::1]:${s.port}` }, body }, 403],
    ['a name that only starts right', { headers: { host: `127.0.0.1:${s.port}.example.com` }, body }, 403],
    ['plain text', { headers: { 'content-type': 'text/plain' }, body }, 415],
    ['a form', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, 415],
    ['a type that only starts like JSON', { headers: { 'content-type': 'application/jsonp' }, body }, 415],
    ['an empty content type', { headers: { 'content-type': '' }, body }, 415],
  ];
  for (const [name, request, status] of refusals) {
    const response = await send(s.port, request);
    assert.equal(response.status, status, name);
    errorOf(response);
    assert.equal(response.text.includes('red ball'), false, name);
  }
  assert.equal(s.calls.length, 0, 'answer was never called');
  assert.deepEqual(spy.seen, [], 'the body was never read');
  // The same server still answers a proper request, under both of its names.
  s.answer = async (body, write) => { write('hello'); };
  for (const host of [own, `localhost:${s.port}`, `LOCALHOST:${s.port}`]) {
    const fine = await send(s.port, { json: chat(), headers: { host, 'content-type': 'application/json; charset=utf-8' } });
    assert.equal(fine.status, 200, host);
    assert.deepEqual(deltas(fine.text), ['hello']);
  }
  assert.equal(s.calls.length, 3);
  // A query after the path is still the path.
  assert.equal((await send(s.port, { path: `${PATH}?beta=true`, json: chat() })).status, 200);
});

test('a refusal is logged without anything from the request', async (t) => {
  const s = await serve(t);
  await send(s.port, { headers: { origin: `https://${SECRET}.example` }, json: chat({ note: SECRET }) });
  await send(s.port, { path: `/dshproxy/video/${encodeURIComponent(SECRET)}`, json: chat() });
  assert.equal(s.log.length, 2);
  for (const line of s.log) {
    assert.match(line, /^video picker: /);
    assert.equal(line.includes('PLANTED'), false);
    assert.equal(line.includes('example'), false);
  }
});

test('a short answer is the exact event stream of a text-only message', async (t) => {
  const s = await serve(t, { answer: async (body, write) => { write('Quote: 856 units.'); } });
  const request = chat({ system: 'You are a coding agent', tools: [{ name: 'shell' }] });
  const response = await send(s.port, { json: request });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream');
  assert.equal(response.headers['cache-control'], 'no-store');
  const all = events(response.text);
  assert.deepEqual(all.map(([name]) => name), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  for (const [name, data] of all) assert.equal(data.type, name);
  const [start, blockStart, delta, blockStop, messageDelta, stop] = all.map(([, data]) => data);
  assert.match(start.message.id, /^msg_[A-Za-z0-9]{8,64}$/);
  assert.deepEqual(start, { type: 'message_start', message: { id: start.message.id, type: 'message', role: 'assistant', model: 'seedance-2.5/720p/krea',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  assert.deepEqual(blockStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  assert.deepEqual(delta, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Quote: 856 units.' } });
  assert.deepEqual(blockStop, { type: 'content_block_stop', index: 0 });
  assert.equal(messageDelta.delta.stop_reason, 'end_turn');
  assert.equal(messageDelta.delta.stop_sequence, null);
  assert.ok(Number.isInteger(messageDelta.usage.output_tokens) && messageDelta.usage.output_tokens >= 1 && messageDelta.usage.output_tokens < 1000);
  assert.deepEqual(stop, { type: 'message_stop' });
  // Never a tool call or a thinking block, whatever the request carried.
  assert.equal(/tool_use|thinking|input_json/.test(response.text), false);
  // answer got the parsed body, a write function and a signal that did not fire.
  assert.equal(s.calls.length, 1);
  const [body, write, options] = s.calls[0];
  assert.deepEqual(body, request);
  assert.equal(typeof write, 'function');
  assert.ok(options.signal instanceof AbortSignal);
  await Promise.all(s.settled);
  assert.equal(options.signal.aborted, false, 'a finished answer is not a client that went away');
  assert.deepEqual(s.log, []);
});

test('text is carried exactly: quotes, line breaks, markup, emoji and separators', async (t) => {
  const pieces = ['line one\nline two\r\n', '"quoted" \\ back\\slash </script> <b>', 'data: {"type":"message_stop"}\n\nevent: message_stop\n', 'đ š 日本 🎬 \u2028\u2029 \u0000\u0007', '```\nfenced\n```'];
  const s = await serve(t, { answer: async (body, write) => { for (const piece of pieces) write(piece); } });
  const response = await send(s.port, { json: chat() });
  assert.deepEqual(deltas(response.text), pieces);
  assert.deepEqual(events(response.text).map(([name]) => name).filter((name) => name !== 'content_block_delta'),
    ['message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop']);
});

test('what is not text is never written as an event of its own', async (t) => {
  const s = await serve(t, { answer: async (body, write) => {
    write('a'); write(''); write(undefined); write(null); write(7); write({ type: 'tool_use' }); write(Symbol('x')); write(['x']); write('b');
  } });
  const response = await send(s.port, { json: chat() });
  assert.deepEqual(deltas(response.text), ['a', '7', 'b']);
});

test('pieces written over time arrive as separate deltas, each when it is written', { timeout: 30000 }, async (t) => {
  const gates = [deferred(), deferred()];
  const s = await serve(t, { answer: async (body, write) => {
    write('Buying one clip.');
    await gates[0].promise;
    write(' .');
    await gates[1].promise;
    write(' Done.');
  } });
  const seen = [];
  const finished = deferred();
  const req = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: PATH, agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      text += chunk;
      const now = deltas(text.slice(0, text.lastIndexOf('\n\n') + 2));
      // The next piece is released only once the one before it has arrived.
      if (now.length > seen.length) {
        seen.push(now.slice());
        const gate = gates[now.length - 1];
        if (gate) gate.resolve();
      }
    });
    res.on('end', () => finished.resolve(text));
  });
  req.end(JSON.stringify(chat()));
  const text = await finished.promise;
  assert.deepEqual(seen, [['Buying one clip.'], ['Buying one clip.', ' .'], ['Buying one clip.', ' .', ' Done.']]);
  assert.deepEqual(deltas(text), ['Buying one clip.', ' .', ' Done.']);
});

test('a client that hangs up mid-answer aborts the signal, later writes are dropped, and the server keeps serving', { timeout: 30000 }, async (t) => {
  const first = deferred();
  const over = deferred();
  const s = await serve(t, { answer: async (body, write, { signal }) => {
    write('Generating');
    await first.promise;
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    const results = [];
    // None of these may throw, however many there are.
    for (let i = 0; i < 50; i += 1) results.push(write(` .${i}`));
    over.resolve({ aborted: signal.aborted, results });
  } });
  const req = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: PATH, agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
    res.once('data', () => { req.destroy(); first.resolve(); });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  req.end(JSON.stringify(chat()));
  const outcome = await over.promise;
  assert.equal(outcome.aborted, true);
  assert.equal(outcome.results.some(Boolean), false, 'writes after the client went away report that they were dropped');
  await Promise.all(s.settled);
  s.answer = async (body, write) => { write('still here'); };
  const next = await send(s.port, { json: chat() });
  assert.equal(next.status, 200);
  assert.deepEqual(deltas(next.text), ['still here']);
  assert.deepEqual(s.log, [], 'a client that leaves is not an error');
});

test('a client that hangs up while its body is still arriving is dropped quietly', { timeout: 30000 }, async (t) => {
  const s = await serve(t);
  const socket = net.connect(s.port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(`POST ${PATH} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"messages":[`);
  await new Promise((resolve) => setImmediate(resolve));
  socket.destroy();
  await new Promise((resolve) => socket.once('close', resolve));
  s.answer = async (body, write) => { write('alive'); };
  const next = await send(s.port, { json: chat() });
  assert.deepEqual(deltas(next.text), ['alive']);
  assert.equal(s.calls.length, 1, 'the half-sent request never reached answer');
});

test('answer throwing at once: the stream ends cleanly with one fixed line, and the next request is served', async (t) => {
  const s = await serve(t, { answer: () => { throw new RangeError(`boom ${SECRET}`); } });
  const response = await send(s.port, { json: chat({ note: 'request text that must not be logged' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(deltas(response.text), [FAILED]);
  assert.deepEqual(events(response.text).map(([name]) => name), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(response.text.includes('PLANTED'), false);
  assert.equal(s.log.length, 1);
  assert.match(s.log[0], /^video picker: .*RangeError/);
  assert.equal(s.log[0].includes('PLANTED'), false);
  assert.equal(s.log[0].includes('boom'), false);
  assert.equal(s.log[0].includes('request text'), false);
  s.answer = async (body, write) => { write('next'); };
  assert.deepEqual(deltas((await send(s.port, { json: chat() })).text), ['next']);
});

test('answer rejecting before its first write: the same fixed line', async (t) => {
  const s = await serve(t, { answer: async () => { await null; throw new TypeError(`early ${SECRET}`); } });
  const response = await send(s.port, { json: chat() });
  assert.equal(response.status, 200);
  assert.deepEqual(deltas(response.text), [FAILED]);
  assert.equal(events(response.text).at(-1)[0], 'message_stop');
  assert.match(s.log[0], /TypeError/);
  assert.equal(s.log.join('\n').includes('PLANTED'), false);
  s.answer = async (body, write) => { write('next'); };
  assert.deepEqual(deltas((await send(s.port, { json: chat() })).text), ['next']);
});

test('answer rejecting after some text: the text stays, the fixed line follows on its own line, the stream closes cleanly', async (t) => {
  class PurchaseTrouble extends Error {}
  const s = await serve(t, { answer: async (body, write) => { write('Buying one clip.'); await null; write(' Sent once.'); throw new PurchaseTrouble(`late ${SECRET}`); } });
  const response = await send(s.port, { json: chat() });
  assert.equal(response.status, 200);
  assert.deepEqual(deltas(response.text), ['Buying one clip.', ' Sent once.', `\n\n${FAILED}`]);
  assert.deepEqual(events(response.text).map(([name]) => name).slice(-3), ['content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(response.text.includes('PLANTED'), false);
  assert.equal(s.log.length, 1);
  assert.match(s.log[0], /PurchaseTrouble/);
  assert.equal(s.log[0].includes('PLANTED'), false);
  s.answer = async (body, write) => { write('next'); };
  assert.deepEqual(deltas((await send(s.port, { json: chat() })).text), ['next']);
});

test('answer rejecting with something that is not an error, or with an error whose name is text of its own, logs no such text', async (t) => {
  const s = await serve(t);
  const hostile = new Error('x');
  Object.defineProperty(hostile, 'constructor', { value: { name: `Evil ${SECRET}` } });
  for (const thrown of [SECRET, { message: SECRET }, null, undefined, 42, hostile]) {
    s.answer = () => Promise.reject(thrown);
    const response = await send(s.port, { json: chat() });
    assert.deepEqual(deltas(response.text), [FAILED]);
  }
  assert.equal(s.log.length, 6);
  assert.equal(s.log.join('\n').includes('PLANTED'), false);
  assert.equal(s.log.join('\n').includes('Evil'), false);
});

test('a failure before anything was sent is a 500 with a short JSON error, and the next request is served', async (t) => {
  // The stream cannot be opened: the first attempt to send headers fails.
  const s = await serve(t, { answer: async (body, write) => { write('never'); }, watch: (req, res) => {
    if (!req.headers['x-break']) return;
    const real = res.writeHead;
    res.writeHead = function () { res.writeHead = real; throw new EvalError(`cannot open ${SECRET}`); };
  } });
  const response = await send(s.port, { json: chat(), headers: { 'x-break': '1' } });
  assert.equal(response.status, 500);
  assert.equal(errorOf(response).message.includes('PLANTED'), false);
  assert.equal(s.log.length, 1);
  assert.match(s.log[0], /EvalError/);
  assert.equal(s.log[0].includes('PLANTED'), false);
  const next = await send(s.port, { json: chat() });
  assert.deepEqual(deltas(next.text), ['never']);
});

test('a body over the limit is refused with 413 and never parsed or answered', async (t) => {
  const s = await serve(t, { maxBytes: 2048 });
  const big = JSON.stringify(chat({ padding: 'x'.repeat(4096) }));
  // Announced: refused at the door.
  const announced = await send(s.port, { body: big });
  assert.equal(announced.status, 413);
  errorOf(announced);
  // Not announced (sent in pieces): refused as soon as the limit is passed.
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: PATH, agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    for (let at = 0; at < big.length; at += 512) req.write(big.slice(at, at + 512));
    req.end();
  });
  assert.equal(chunked.status, 413);
  errorOf(chunked);
  assert.equal(s.calls.length, 0);
  // Exactly at the limit is accepted.
  const padded = (size) => { const base = JSON.stringify(chat({ padding: '' })); return JSON.stringify(chat({ padding: 'x'.repeat(size - Buffer.byteLength(base)) })); };
  assert.equal(Buffer.byteLength(padded(2048)), 2048);
  assert.equal((await send(s.port, { body: padded(2048) })).status, 200);
  assert.equal((await send(s.port, { body: padded(2049) })).status, 413);
  assert.equal(s.calls.length, 1);
});

test('the limit is 32 MiB unless another is given, so a 2 MiB request is answered', async (t) => {
  assert.equal(picker.MAX_BODY_BYTES, 32 * 1024 * 1024);
  const s = await serve(t, { answer: async (body, write) => { write(String(body.system.length)); } });
  const response = await send(s.port, { json: chat({ system: 's'.repeat(2 * 1024 * 1024) }) });
  assert.equal(response.status, 200);
  assert.deepEqual(deltas(response.text), [String(2 * 1024 * 1024)]);
});

test('a body that is not a JSON object with a list of user and assistant messages is a 400', async (t) => {
  const s = await serve(t);
  const bodies = [
    ['nothing', ''],
    ['not JSON', '{"messages":['],
    ['text', '"yes"'],
    ['a number', '7'],
    ['null', 'null'],
    ['true', 'true'],
    ['a list', JSON.stringify([chat()])],
    ['bytes that are not UTF-8', Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d])],
    ['no messages', JSON.stringify({ model: 'm', stream: true })],
    ['messages as text', JSON.stringify(chat({ messages: 'yes' }))],
    ['messages as an object', JSON.stringify(chat({ messages: { role: 'user', content: 'yes' } }))],
    ['messages as null', JSON.stringify(chat({ messages: null }))],
    ['a system message', JSON.stringify(chat({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'yes' }] }))],
    ['a tool message', JSON.stringify(chat({ messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: 'yes' }] }))],
    ['a message without a role', JSON.stringify(chat({ messages: [{ content: 'yes' }] }))],
    ['a message that is text', JSON.stringify(chat({ messages: ['yes'] }))],
    ['a message that is null', JSON.stringify(chat({ messages: [null] }))],
    ['a message that is a list', JSON.stringify(chat({ messages: [[{ role: 'user' }]] }))],
    ['a role that is not text', JSON.stringify(chat({ messages: [{ role: ['user'], content: 'yes' }] }))],
  ];
  for (const [name, body] of bodies) {
    const response = await send(s.port, { body });
    assert.equal(response.status, 400, name);
    errorOf(response);
  }
  assert.equal(s.calls.length, 0);
  // Shapes that are for answer to judge, not for the door.
  s.answer = async (body, write) => { write('ok'); };
  for (const fine of [chat({ messages: [] }), chat({ model: 7 }), chat({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'q' }] }, { role: 'user', content: null }] })]) {
    assert.equal((await send(s.port, { json: fine })).status, 200);
  }
  assert.equal(s.calls.length, 3);
});

test('a request that does not ask for a stream gets one JSON message with what answer wrote', async (t) => {
  const s = await serve(t, { answer: async (body, write) => { write('Quote: '); await null; write('856 units.'); write(7); } });
  for (const stream of [false, undefined, 'true', 1, null]) {
    const request = chat({ stream });
    const response = await send(s.port, { json: request });
    assert.equal(response.status, 200, String(stream));
    assert.match(response.headers['content-type'], /^application\/json/);
    assert.equal(response.headers['cache-control'], 'no-store');
    const message = JSON.parse(response.text);
    assert.match(message.id, /^msg_[A-Za-z0-9]{8,64}$/);
    assert.deepEqual(message, { id: message.id, type: 'message', role: 'assistant', model: 'seedance-2.5/720p/krea',
      content: [{ type: 'text', text: 'Quote: 856 units.7' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: message.usage.output_tokens } });
    assert.ok(Number.isInteger(message.usage.output_tokens) && message.usage.output_tokens >= 1 && message.usage.output_tokens < 1000);
    assert.equal(response.text.includes('event:'), false);
  }
  assert.equal(s.calls.length, 5);
  const [body, write, options] = s.calls[0];
  assert.deepEqual(body, chat({ stream: false }));
  assert.equal(typeof write, 'function');
  assert.ok(options.signal instanceof AbortSignal);
});

test('without a stream, answer failing in any way is a 500 with a short error, and the next request is served', async (t) => {
  const s = await serve(t);
  const failures = [
    () => { throw new RangeError(`sync ${SECRET}`); },
    async () => { await null; throw new RangeError(`early ${SECRET}`); },
    async (body, write) => { write(`partial ${SECRET}`); await null; throw new RangeError(`late ${SECRET}`); },
  ];
  for (const answer of failures) {
    s.answer = answer;
    const response = await send(s.port, { json: chat({ stream: false }) });
    assert.equal(response.status, 500);
    errorOf(response);
    assert.equal(response.text.includes('PLANTED'), false);
  }
  assert.equal(s.log.length, 3);
  for (const line of s.log) { assert.match(line, /RangeError/); assert.equal(line.includes('PLANTED'), false); }
  s.answer = async (body, write) => { write('next'); };
  assert.equal(JSON.parse((await send(s.port, { json: chat({ stream: false }) })).text).content[0].text, 'next');
});

test('without a stream, a client that hangs up aborts the signal and the server keeps serving', { timeout: 30000 }, async (t) => {
  const started = deferred();
  const over = deferred();
  const s = await serve(t, { answer: async (body, write, { signal }) => {
    started.resolve();
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    write('late');
    over.resolve(signal.aborted);
  } });
  const req = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: PATH, agent: false, headers: { 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.end(JSON.stringify(chat({ stream: false })));
  await started.promise;
  req.destroy();
  assert.equal(await over.promise, true);
  await Promise.all(s.settled);
  s.answer = async (body, write) => { write('next'); };
  assert.equal(JSON.parse((await send(s.port, { json: chat({ stream: false }) })).text).content[0].text, 'next');
});

test('the handler always returns a promise that resolves, and refuses to be made without its parts', async (t) => {
  const s = await serve(t, { answer: () => { throw new Error('x'); } });
  await send(s.port, { json: chat() });
  await send(s.port, { method: 'GET' });
  await send(s.port, { body: 'nope' });
  assert.equal(s.settled.length, 3);
  for (const result of s.settled) assert.equal(await result, undefined);
  assert.throws(() => picker.handler({ origin: 'http://127.0.0.1:8417' }), TypeError);
  assert.throws(() => picker.handler({ answer: async () => {}, origin: 'not an address' }), TypeError);
  assert.throws(() => picker.handler({ answer: async () => {}, origin: 'https://127.0.0.1:8417' }), TypeError);
  assert.throws(() => picker.handler({ answer: async () => {} }), TypeError);
  assert.throws(() => picker.handler({ answer: async () => {}, origin: 'http://127.0.0.1:8417', maxBytes: 0 }), TypeError);
});

test('a logger that throws cannot take a request down', async (t) => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const { port } = server.address();
  server.on('request', picker.handler({ answer: () => { throw new Error('x'); }, origin: `http://127.0.0.1:${port}`, log: () => { throw new Error('the log is broken'); } }));
  const response = await send(port, { json: chat() });
  assert.deepEqual(deltas(response.text), [FAILED]);
  assert.equal((await send(port, { method: 'GET' })).status, 404);
});
