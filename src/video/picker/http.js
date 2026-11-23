'use strict';
// The HTTP side of the video entries in a chat application's model picker.
//
// Chat requests for a video entry arrive on a path of their own under the
// gateway's address, POST /dshproxy/video/v1/messages, so "is this request for
// the picker" is answered from the request line alone. `mount` puts that
// question in front of the gateway's own request listener: every other
// request reaches that listener exactly as before, with nothing read from it.
//
// `handler` checks a picker request before any of its body is read, then
// hands the parsed body to `answer(body, write, { signal })` and carries what
// `answer` writes back as an Anthropic text answer. What a request means, and
// whether anything is quoted or bought, is `answer`'s business alone.
//
// Nothing in this file may take the gateway process down: a throw or a
// rejected promise from `answer`, from the stream or from this file itself
// ends in an error answer for that one request. Log lines carry a fixed
// phrase and at most the class name of an error, never text from a request or
// from an error.
const stream = require('./stream');

const PREFIX = '/dshproxy/video/';
const MESSAGES_PATH = '/dshproxy/video/v1/messages';
// A chat request carries the application's whole system text and tool list.
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const FAILED_LINE = 'Something went wrong inside DSHProxy; nothing further was sent.';

const TOO_LARGE = Symbol('too large');
const GONE = Symbol('client gone');
const noop = () => {};

// True for a request under the picker's path. Reads the address and nothing else.
function claims(req) {
  return typeof req.url === 'string' && req.url.startsWith(PREFIX);
}

// The class of an error, for a log line: the name of its constructor when
// that is an ordinary identifier, otherwise nothing. Never its message.
function className(error) {
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return '';
    const name = error.constructor && error.constructor.name;
    return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : '';
  } catch {
    return '';
  }
}

function sendJson(res, status, value) {
  try {
    if (res.destroyed || res.writableEnded) return;
    const text = JSON.stringify(value);
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
    res.end(text);
  } catch {
    // Nothing more can be said on this response.
  }
}

// A short error in the shape the Anthropic client reads. `message` is always
// one of this file's own sentences.
function refuse(res, status, code, message) {
  sendJson(res, status, { type: 'error', error: { type: `dshproxy_video_${code}`, message } });
}

// The last thing done for a response after a failure nobody handled: an error
// answer when nothing was sent yet, otherwise the end of what was sent.
function giveUp(res) {
  try {
    if (!res.headersSent) return refuse(res, 500, 'failed', 'Something went wrong inside DSHProxy. Nothing was sent.');
    if (!res.writableEnded && !res.destroyed) res.end();
  } catch {
    try { res.destroy(); } catch { /* already gone */ }
  }
}

// The Host values that are the gateway's own: 127.0.0.1 and localhost on the
// gateway's port. A web page that reaches the gateway through another name
// (DNS rebinding) sends that other name.
function ownHosts(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new TypeError('The video picker needs the gateway\'s own address, such as http://127.0.0.1:8417.');
  }
  if (url.protocol !== 'http:') throw new TypeError('The video picker needs the gateway\'s own address, such as http://127.0.0.1:8417.');
  const port = url.port || '80';
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (port === '80') for (const name of ['127.0.0.1', 'localhost']) hosts.add(name);
  return hosts;
}

function isJson(contentType) {
  return typeof contentType === 'string' && /^application\/json\s*(?:;|$)/i.test(contentType.trim());
}

// Reads a request body of at most `limit` bytes. Resolves to the bytes, to
// TOO_LARGE as soon as the limit is passed (what was read is dropped and the
// rest is not kept), or to GONE when the client went away first. Never rejects.
function readBody(req, limit) {
  return new Promise((resolve) => {
    let chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      req.removeListener('data', onData);
      chunks = null;
      resolve(value);
    };
    function onData(chunk) {
      size += chunk.length;
      if (size > limit) {
        finish(TOO_LARGE);
        // The rest is taken off the wire and thrown away.
        req.resume();
        return;
      }
      chunks.push(chunk);
    }
    req.on('data', onData);
    req.once('end', () => finish(done ? null : Buffer.concat(chunks)));
    req.once('error', () => finish(GONE));
    req.once('aborted', () => finish(GONE));
    req.once('close', () => finish(GONE));
  });
}

// Row 2 of the design's table: a list of messages, each from the user or the
// assistant. What the messages say is not looked at here.
function hasMessages(body) {
  return Array.isArray(body.messages) && body.messages.every((message) => message !== null && typeof message === 'object' && !Array.isArray(message)
    && (message.role === 'user' || message.role === 'assistant'));
}

// handler({ answer, origin, log, maxBytes }) returns (req, res) => Promise.
// The promise always resolves, to nothing, once the request has been dealt
// with as far as it can be.
//
//   answer(body, write, { signal })  body: the parsed request. write(piece):
//       text for the user; never throws; true when the piece was taken, false
//       when it was dropped because the client has gone. signal: aborts when
//       the client goes away before the answer is complete. May return a
//       promise; the answer ends when it settles.
//   origin    the gateway's own address, for the Host check.
//   log(line) optional.
//   maxBytes  the largest request body that is read.
function handler({ answer, origin, log = noop, maxBytes = MAX_BODY_BYTES } = {}) {
  if (typeof answer !== 'function') throw new TypeError('The video picker needs a function that answers a request.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('The video picker\'s body limit must be a whole number of bytes.');
  const hosts = ownHosts(origin);
  const note = (what, error) => {
    try {
      const name = error === undefined ? '' : className(error);
      log(`video picker: ${what}${name ? ` (${name})` : ''}`);
    } catch {
      // A log that fails must not fail the request.
    }
  };
  const turnAway = (res, status, code, message) => {
    note(`refused a request (${code}, HTTP ${status})`);
    refuse(res, status, code, message);
  };

  // Design 4.3, row 1. Returns [status, code, message] or null. Reads the
  // request line and the headers only.
  function door(req) {
    const path = String(req.url).split('?', 1)[0];
    if (path !== MESSAGES_PATH) return [404, 'not_found', 'There is nothing at this address. Video entries answer POST /dshproxy/video/v1/messages only.'];
    if (req.method !== 'POST') return [404, 'not_found', 'Video entries answer POST /dshproxy/video/v1/messages only.'];
    if (req.headers.origin !== undefined) return [403, 'forbidden', 'Requests from a web page are not accepted here.'];
    if (!hosts.has(String(req.headers.host === undefined ? '' : req.headers.host).toLowerCase())) return [403, 'forbidden', 'This address answers under the gateway\'s own name only.'];
    if (!isJson(req.headers['content-type'])) return [415, 'unsupported_media_type', 'The request body must be JSON.'];
    const announced = Number(req.headers['content-length']);
    if (Number.isFinite(announced) && announced > maxBytes) return [413, 'too_large', 'The request is larger than a video entry accepts.'];
    return null;
  }

  // Calls `answer`; a throw becomes a rejection.
  const ask = async (body, write, signal) => { await answer(body, write, { signal }); };

  async function respond(req, res, raw) {
    if (raw === GONE) return;
    if (raw === TOO_LARGE) return turnAway(res, 413, 'too_large', 'The request is larger than a video entry accepts.');
    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      return turnAway(res, 400, 'invalid_request', 'The request body is not valid JSON.');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return turnAway(res, 400, 'invalid_request', 'The request body must be a JSON object.');
    if (!hasMessages(body)) return turnAway(res, 400, 'invalid_request', 'The request needs a list of messages, each from the user or the assistant.');

    // Aborts when the client goes away before the answer is complete.
    const client = new AbortController();
    let complete = false;
    const onClose = () => { if (!complete) client.abort(); };
    res.once('close', onClose);
    if (res.destroyed) client.abort();

    if (body.stream !== true) {
      // Design 4.3, row 3: no event stream; the whole answer as one message.
      const pieces = [];
      const write = (piece) => { const text = stream.asText(piece); if (text) pieces.push(text); return Boolean(text); };
      try {
        await ask(body, write, client.signal);
      } catch (error) {
        complete = true;
        note('the answer failed; nothing had been sent', error);
        return refuse(res, 500, 'failed', 'Something went wrong inside DSHProxy. Nothing was sent.');
      }
      complete = true;
      return sendJson(res, 200, stream.message(pieces.join(''), { model: body.model }));
    }

    // If this throws, nothing was sent and the caller answers 500.
    const out = stream.open(res, { model: body.model });
    let wrote = false;
    const write = (piece) => {
      const taken = out.text(piece);
      wrote = wrote || taken;
      return taken;
    };
    try {
      await ask(body, write, client.signal);
    } catch (error) {
      note('the answer failed part-way; it was ended with the fixed line', error);
      out.text(`${wrote ? '\n\n' : ''}${FAILED_LINE}`);
    }
    complete = true;
    out.close();
  }

  return function handle(req, res) {
    try {
      // A response that fails while being written must not become an uncaught error.
      res.on('error', noop);
      const refusal = door(req);
      if (refusal) {
        turnAway(res, ...refusal);
        return Promise.resolve();
      }
      return readBody(req, maxBytes)
        .then((raw) => respond(req, res, raw))
        .catch((error) => {
          note('a request failed', error);
          giveUp(res);
        });
    } catch (error) {
      note('a request failed', error);
      giveUp(res);
      return Promise.resolve();
    }
  };
}

// Puts the picker in front of a server's one request listener.
//
//   handler(req, res)  takes the requests that `claims` holds for. When it is
//       not a function (the picker could not be made), those requests are
//       answered 503 and still never reach the server's own listener.
//   claims(req)        defaults to this module's.
//   log(line)          optional.
//
// Every other request reaches the server's own listener with the same `this`,
// `req` and `res`, and nothing is read from it first but what `claims` reads.
// A `claims` that throws counts as "not mine". A handler that throws, or whose
// promise rejects, is answered for that request and goes no further.
//
// It must run before anything else listens for requests (the gateway's
// request counter is prepended later): a server with no listener or with more
// than one is refused, and left as it was.
function mount(server, { handler: handle, claims: mine = claims, log = noop } = {}) {
  const listeners = server.listeners('request');
  if (listeners.length !== 1) throw new Error('The video picker must be mounted before anything else listens for requests.');
  if (typeof mine !== 'function') throw new TypeError('The video picker needs a function that says which requests are its own.');
  const [forward] = listeners;
  const failed = (res, error) => {
    try {
      const name = className(error);
      log(`video picker: a request failed${name ? ` (${name})` : ''}`);
    } catch {
      // A log that fails must not fail the request.
    }
    giveUp(res);
  };
  server.removeListener('request', forward);
  server.on('request', function pickerOrForward(req, res) {
    let claimed = false;
    try {
      claimed = mine(req) === true;
    } catch {
      claimed = false;
    }
    if (!claimed) return forward.call(this, req, res);
    try {
      if (typeof handle !== 'function') return refuse(res, 503, 'unavailable', 'Video entries are not available: the video picker could not be started. Chat is not affected.');
      const result = handle(req, res);
      if (result && typeof result.then === 'function') result.then(undefined, (error) => failed(res, error));
    } catch (error) {
      failed(res, error);
    }
    return undefined;
  });
}

module.exports = { claims, handler, mount, PREFIX, MESSAGES_PATH, MAX_BODY_BYTES, FAILED_LINE };
