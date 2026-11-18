const { carriesImage } = require("./content");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { prepareBody } = require("./request");
const { needsBody } = require("./failover");

// The HTTP server DeepSeek Harness talks to. It forwards everything to
// CLIProxyAPI and adds one thing: a request for a lane is tried on each rung
// of the lane's ladder until one serves it.

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"];
const STATUS_PATH = "/dshproxy/status";
// Error replies are small. Anything larger is passed on without being judged.
const MAX_JUDGED_BYTES = 64 * 1024;
const MAX_JUDGED_TEXT = 1024 * 1024;
// Requests carry whole conversations with images, so the limit is generous.
const MAX_BODY_BYTES = 256 * 1024 * 1024;

const DECODERS = {
  gzip: zlib.gunzipSync,
  "x-gzip": zlib.gunzipSync,
  deflate: zlib.inflateSync,
  br: zlib.brotliDecompressSync,
  zstd: zlib.zstdDecompressSync
};

function withoutHopByHop(headers) {
  const kept = { ...headers };
  for (const name of HOP_BY_HOP) delete kept[name];
  return kept;
}

function sendJson(res, status, value) {
  if (res.destroyed) return;
  const text = JSON.stringify(value);
  if (!res.headersSent) res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

// Reads a whole response of at most MAX_JUDGED_BYTES. Resolves to null (and
// leaves the stream paused with what was read in `chunks`) when it is larger.
function readSmall(stream, chunks) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const onData = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size <= MAX_JUDGED_BYTES) return;
      stream.pause();
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      resolve(null);
    };
    const onEnd = () => resolve(Buffer.concat(chunks));
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", reject);
  });
}

// Text of an error reply, or undefined when it cannot be decoded. The client
// still receives the original bytes.
function decodedText(buffer, encoding) {
  if (!encoding) return buffer.toString("utf8");
  const decode = DECODERS[String(encoding).trim().toLowerCase()];
  if (!decode) return undefined;
  try {
    return decode(buffer, { maxOutputLength: MAX_JUDGED_TEXT }).toString("utf8");
  } catch {
    return undefined;
  }
}

// `resolve(modelId)` returns { lane, ladder }: the lane name (or null) and the
// models to try in order. `describe(model)` returns { efforts, upstream } for
// a model the catalog knows, or {} otherwise. `sessions` keeps a conversation
// on the rung that served it.
// `control(req, res)` handles the app's control calls and returns true when it
// took the request.
// A compact description of a model request: enough to tell a normal turn from a
// pathological one (huge images, absurd token budgets, unexpected shape).
function describeRequest(parsed, raw) {
  const text = raw.toString("utf8");
  let images = 0;
  let imageBytes = 0;
  for (const match of text.matchAll(/data:[^;,]{1,40};base64,/g)) {
    images += 1;
    imageBytes += 1;
  }
  const base64 = text.split(";base64,").slice(1);
  imageBytes = base64.reduce((sum, part) => sum + part.length, 0);
  const messages = Array.isArray(parsed?.messages) ? parsed.messages.length : 0;
  const tools = Array.isArray(parsed?.tools) ? parsed.tools.length : 0;
  const system = typeof parsed?.system === "string" ? parsed.system.length : 0;
  const maxTokens = parsed?.max_tokens ?? parsed?.max_completion_tokens ?? null;
  return `bytes=${raw.length} messages=${messages} tools=${tools} images=${images} imageMB=${(imageBytes / 1048576).toFixed(1)} systemChars=${system} maxTokens=${maxTokens} stream=${Boolean(parsed?.stream)}`;
}
// The request's structure without its text: which keys the harness sends, the
// role/type mix of the conversation and the tool names. Enough to spot an
// unexpected shape without storing the conversation itself.
function describeShape(parsed) {
  const shape = {
    keys: parsed && typeof parsed === "object" ? Object.keys(parsed) : [],
    roles: {},
    parts: {},
    tools: Array.isArray(parsed?.tools) ? parsed.tools.map((tool) => tool?.function?.name || tool?.name || tool?.type || "?").slice(0, 40) : [],
    toolCalls: 0,
    toolResults: 0
  };
  for (const message of Array.isArray(parsed?.messages) ? parsed.messages : []) {
    const role = message?.role || "?";
    shape.roles[role] = (shape.roles[role] || 0) + 1;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      const type = part?.type || "text";
      shape.parts[type] = (shape.parts[type] || 0) + 1;
    }
    if (Array.isArray(message?.tool_calls)) shape.toolCalls += message.tool_calls.length;
    if (role === "tool") shape.toolResults += 1;
  }
  return shape;
}
// Account-level circuit breaker: several models of one account answering 429 in
// a row means the account is throttled, not the models.
const ACCOUNT_STRIKE_WINDOW_MS = 45 * 1000;
const ACCOUNT_STRIKE_LIMIT = 3;
const ACCOUNT_COOLDOWN_MS = 60 * 1000;
// A model the usage report shows as used up is asked again after this long at
// most, so a limit that was raised or reset early is noticed.
const QUOTA_RECHECK_MS = 60 * 60 * 1000;

// `quotaReset(model)` resolves to the time (ms) the provider's usage report
// says the model's quota returns, or null when it is not used up or unknown.
function createGateway({ upstream, resolve, describe = () => ({}), failover, sessions = null, log = () => {}, status = () => ({}), control = null, supportsImages = null, accountOf = () => null, retryDelays = [2000, 5000, 12000, 20000], quotaReset = null, quotaLookupMs = 4000, maxBodyBytes = MAX_BODY_BYTES }) {
  // A 429 that carries no time may be a throttle that passes in a minute or a
  // weekly limit that is used up. The usage report tells them apart. Never
  // rejects, and gives up after `quotaLookupMs`.
  const usedUpUntil = (model) => {
    if (!quotaReset) return Promise.resolve(null);
    let timer;
    const tooSlow = new Promise((done) => {
      timer = setTimeout(done, quotaLookupMs, null);
    });
    const asked = Promise.resolve()
      .then(() => quotaReset(model))
      .then((reset) => (Number.isFinite(reset) && reset > Date.now() ? reset : null), () => null);
    return Promise.race([asked, tooSlow]).finally(() => clearTimeout(timer));
  };

  const accountStrikes = new Map();
  const accountCoolingUntil = new Map();

  const accountCooling = (model) => {
    const account = accountOf(model);
    if (!account) return false;
    const until = accountCoolingUntil.get(account);
    if (!until) return false;
    if (until <= Date.now()) { accountCoolingUntil.delete(account); accountStrikes.delete(account); return false; }
    return true;
  };

  const noteAccountStrike = (model) => {
    const account = accountOf(model);
    if (!account || accountCooling(model)) return;
    const now = Date.now();
    const stamps = (accountStrikes.get(account) || []).filter((at) => now - at < ACCOUNT_STRIKE_WINDOW_MS);
    stamps.push(now);
    accountStrikes.set(account, stamps);
    if (stamps.length >= ACCOUNT_STRIKE_LIMIT) {
      accountCoolingUntil.set(account, now + ACCOUNT_COOLDOWN_MS);
      accountStrikes.delete(account);
      log(`account ${account} is rate-limiting: ${ACCOUNT_STRIKE_LIMIT} models answered 429, skipping it for ${ACCOUNT_COOLDOWN_MS / 1000}s`);
    }
  };
  const forward = (req, headers, body, track) => new Promise((resolvePromise, reject) => {
    const out = http.request({
      host: upstream.host,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers: { ...headers, "content-length": String(body.length), host: `${upstream.host}:${upstream.port}` }
    }, resolvePromise);
    out.on("error", reject);
    track(out);
    out.end(body);
  });

  async function handle(req, res, raw) {
    const headers = withoutHopByHop(req.headers);

    // Stop the upstream work when the client goes away.
    let active = null;
    res.on("close", () => {
      if (active) active.destroy();
    });
    const track = (item) => {
      active = item;
    };
    // `read` holds the part of the reply that was already taken off the stream.
    const relay = (upstreamRes, extra = {}, read = null) => {
      active = upstreamRes;
      if (res.destroyed) {
        upstreamRes.destroy();
        return;
      }
      // A reply that breaks off part-way must end the client's request too;
      // otherwise the client waits for the rest forever.
      upstreamRes.on("error", () => res.destroy());
      upstreamRes.on("close", () => {
        if (!upstreamRes.complete && !res.writableEnded) res.destroy();
      });
      res.writeHead(upstreamRes.statusCode || 502, { ...withoutHopByHop(upstreamRes.headers), ...extra });
      if (read) for (const chunk of read) res.write(chunk);
      if (upstreamRes.readableEnded) res.end();
      else {
        upstreamRes.pipe(res);
        upstreamRes.resume();
      }
    };
    const unreachable = (error) => {
      log(`backend did not answer: ${error.message}`);
      sendJson(res, 502, { error: { type: "dshproxy_backend_unreachable", message: `DSHProxy could not reach its backend: ${error.message}` } });
    };

    let parsed = null;
    if (req.method === "POST" && raw.length) {
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        parsed = null;
      }
    }

    // Not a model request: forward as-is.
    if (typeof parsed?.model !== "string") {
      try {
        relay(await forward(req, headers, raw, track));
      } catch (error) {
        if (!res.destroyed) unreachable(error);
      }
      return;
    }

    const route = resolve(parsed.model);
    const label = route.lane ? `lane ${route.lane}` : parsed.model;
    // One line per model request, so a failing turn can be traced without
    // guessing: what arrived, how big it was, and what came back.
    const trace = describeRequest(parsed, raw);
    const startedAt = Date.now();
    const retries = [...retryDelays];
    const report = (code, model) => {
      log(`${label}: HTTP ${code} in ${Date.now() - startedAt}ms${model ? ` served=${model}` : ""} · ${trace}`);
    };
    const dumpFailure = (code, model, text) => {
      try {
        const file = path.join(os.tmpdir(), "dshproxy-last-failed.json");
        fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), url: req.url, lane: route.lane, model: parsed.model, served: model || null, code, trace, shape: describeShape(parsed), error: (text || "").slice(0, 2000) }, null, 2));
      } catch { /* diagnostics are best effort */ }
    };
    if (!route.ladder.length) {
      log(`${label}: no rung is available`);
      sendJson(res, 503, { error: { type: "dshproxy_no_rung", message: `No model on lane "${route.lane}" is available. Sign in to an account or add an API key, then check \`dshproxy status\`.` } });
      return;
    }

    // An image can only be served by a model that accepts one, so those rungs
    // are the only ones tried. A lane with no such rung is refused here rather
    // than failed over rung by rung.
    if (supportsImages && carriesImage(parsed)) {
      const capable = route.ladder.filter((model) => supportsImages(model));
      if (!capable.length) {
        log(`${label}: no rung accepts images`);
        sendJson(res, 400, { error: { type: "dshproxy_no_image_rung", message: `No model on ${route.lane ? `lane "${route.lane}"` : "this route"} accepts images. Pick a vision model such as claude-opus-5-5 or gemini-4-carbon-high.` } });
        return;
      }
      route.ladder = capable;
    }

    // A conversation stays on the rung that last served it, while that rung is
    // still serving. A forced model is the only rung: what the caller selected is
    // what runs, and its failure is returned as it is.
    const forced = route.lane ? null : route.ladder[0];
    // Inside a lane, an account that is being rate-limited is skipped as a whole
    // instead of being walked model by model.
    const laneRungs = route.lane ? route.ladder.filter((model) => !accountCooling(model)) : route.ladder;
    const candidates = route.lane && laneRungs.length ? laneRungs : route.ladder;
    let rungs = failover.order(candidates);
    const sessionKey = route.lane && sessions ? sessions.keyFor(route.lane, headers, parsed) : null;
    const pinned = sessionKey ? sessions.get(sessionKey) : null;
    if (pinned && rungs.includes(pinned) && failover.coolingUntil(pinned) === null) rungs = [pinned, ...rungs.filter((model) => model !== pinned)];

    for (let index = 0; index < rungs.length; index += 1) {
      const model = rungs[index];
      const next = rungs[index + 1];
      let upstreamRes;
      try {
        upstreamRes = await forward(req, { ...headers }, prepareBody(raw, model, describe(model)), track);
      } catch (error) {
        // The client left and the attempt was cancelled: that says nothing
        // about the model.
        if (res.destroyed) return;
        const verdict = failover.report(model, 0);
        if (verdict.failover && next) {
          log(`${label}: ${model} ${verdict.reason}; using ${next}`);
          continue;
        }
        unreachable(error);
        return;
      }

      // A rejection is judged by its text, which is read only when another
      // rung could take the request.
      const code = upstreamRes.statusCode;
      let read = null;
      let text;
      if (next && needsBody(code)) {
        read = [];
        let whole;
        try {
          whole = await readSmall(upstreamRes, read);
        } catch (error) {
          if (!res.destroyed) unreachable(error);
          return;
        }
        if (whole) text = decodedText(whole, upstreamRes.headers["content-encoding"]);
      }

      const verdict = failover.report(model, code, upstreamRes.headers["retry-after"], text);
      if (verdict.failover && route.lane) noteAccountStrike(model);
      // The provider gave no time with its 429: look the model up in the usage
      // report. A lane does not wait for the answer; it only makes the model
      // sit out longer than the ten-minute guess.
      const learned = code === 429 && verdict.source === "default"
        ? usedUpUntil(model).then((reset) => {
          if (reset === null) return null;
          const until = failover.coolUntil(model, Math.min(reset, Date.now() + QUOTA_RECHECK_MS));
          log(`${label}: ${model} is out of quota until about ${new Date(reset).toLocaleString()}, checked again at ${until.toLocaleTimeString()}`);
          return reset;
        }).catch(() => null)
        : Promise.resolve(null);
      if (verdict.failover && next && !res.destroyed) {
        if (!read) upstreamRes.resume();
        log(`${label}: ${model} ${verdict.reason}${verdict.until ? `, skipped until about ${verdict.until.toLocaleTimeString()}` : ""}; using ${next}`);
        continue;
      }

      // The last attempt: keep its body so a failure can be reported and logged
      // with the provider's own words.
      if (!read && code >= 400) {
        read = [];
        try {
          const whole = await readSmall(upstreamRes, read);
          if (whole) text = decodedText(whole, upstreamRes.headers["content-encoding"]);
        } catch (error) {
          if (!res.destroyed) unreachable(error);
          return;
        }
      }
      // A forced pick is strict about *which* model runs, not about giving up
      // after one refusal: providers throttle an account for a minute at a time,
      // so the same model is retried with growing pauses before failing.
      //
      // Not when the provider says the quota returns after the pauses that are
      // left: then every retry is a wasted call, and the answer is returned now.
      if (verdict.failover && !next && forced && retries.length) {
        const delay = retries.shift();
        const pausesLeft = () => retries.reduce((sum, item) => sum + item, 0);
        let reset = verdict.source === "provider" && verdict.until.getTime() - Date.now() > delay + pausesLeft() ? verdict.until.getTime() : null;
        if (reset === null) {
          log(`${label}: HTTP ${code}, retrying the same model in ${delay / 1000}s`);
          // The pause is never longer for the lookup: an answer that comes
          // later has already set the cool-down, and the next refusal sees it.
          let found = null;
          learned.then((value) => {
            found = value;
          });
          await new Promise((done) => setTimeout(done, delay));
          if (res.destroyed) {
            upstreamRes.destroy();
            return;
          }
          if (found !== null && found - Date.now() > pausesLeft()) reset = found;
        }
        if (reset === null) {
          if (!read) upstreamRes.resume();
          index -= 1;
          continue;
        }
        log(`${label}: HTTP ${code}, ${model} is out of quota until about ${new Date(reset).toLocaleString()}; not retrying`);
      }
      report(code, model);
      if (code >= 400) dumpFailure(code, model, text);
      if (res.destroyed) return;
      if (sessionKey && code < 400) sessions.set(sessionKey, model);
      const extra = { "x-dshproxy-model": model };
      if (route.lane) extra["x-dshproxy-lane"] = route.lane;
      relay(upstreamRes, extra, read);
      return;
    }
  }

  return http.createServer((req, res) => {
    // Writing to a client that has gone away must not stop the gateway.
    res.on("error", () => {});
    if (req.method === "GET" && req.url === STATUS_PATH) {
      sendJson(res, 200, status());
      return;
    }
    if (control && req.url.startsWith("/dshproxy/control/")) {
      control(req, res).catch((error) => sendJson(res, 500, { error: error.message }));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        sendJson(res, 413, { error: { type: "dshproxy_request_too_large", message: `The request is larger than ${maxBodyBytes} bytes.` } });
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => res.destroy());
    req.on("end", () => {
      if (tooLarge) return;
      handle(req, res, Buffer.concat(chunks)).catch((error) => {
        log(`request failed: ${error.message}`);
        sendJson(res, 500, { error: { type: "dshproxy_internal", message: error.message } });
      });
    });
  });
}

module.exports = { createGateway, STATUS_PATH };
