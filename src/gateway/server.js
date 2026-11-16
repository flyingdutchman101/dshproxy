const { carriesImage } = require("./content");
const http = require("http");
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
// Account-level circuit breaker: several models of one account answering 429 in
// a row means the account is throttled, not the models.
const ACCOUNT_STRIKE_WINDOW_MS = 45 * 1000;
const ACCOUNT_STRIKE_LIMIT = 3;
const ACCOUNT_COOLDOWN_MS = 60 * 1000;

function createGateway({ upstream, resolve, describe = () => ({}), failover, sessions = null, log = () => {}, status = () => ({}), control = null, supportsImages = null, accountOf = () => null, maxBodyBytes = MAX_BODY_BYTES }) {
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

  const accountWaitSeconds = (model) => {
    const until = accountCoolingUntil.get(accountOf(model));
    return until ? Math.max(1, Math.ceil((until - Date.now()) / 1000)) : 0;
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
      // A fallback rung has to accept the image too.
      if (route.fallbacks) route.fallbacks = route.fallbacks.filter((model) => supportsImages(model));
    }

    // A conversation stays on the rung that last served it, while that rung is
    // still serving. A forced model keeps its own provider's siblings behind it
    // as a safety net, so a transient 429 does not fail the request.
    const forced = route.lane ? null : route.ladder[0];
    // A forced pick tries itself plus at most five siblings: enough to ride out a throttle, not enough to hammer the provider.
    const candidates = route.lane ? route.ladder : [...route.ladder, ...(route.fallbacks || []).slice(0, 5)];
    // An account that is being rate-limited answers 429 for every one of its
    // models. Trying them all (and letting the client retry) is what turns a
    // short throttle into a long one, so the account sits out as a whole.
    const openRungs = candidates.filter((model) => !accountCooling(model));
    let rungs = failover.order(openRungs.length ? openRungs : candidates);
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
      if (verdict.failover) {
        noteAccountStrike(model);
        // The whole account is throttled: stop walking it and say so plainly.
        if (accountCooling(model) && !res.destroyed) {
          if (read) { /* body already consumed */ } else upstreamRes.resume();
          sendJson(res, 429, {
            error: {
              type: "dshproxy_account_rate_limited",
              message: `${accountOf(model) || "The provider"} is rate-limiting this account right now. Pick a model from another provider, or retry in about ${accountWaitSeconds(model)} seconds.`
            }
          });
          return;
        }
      }
      if (verdict.failover && next && !res.destroyed) {
        if (!read) upstreamRes.resume();
        log(`${label}: ${model} ${verdict.reason}${verdict.until ? `, skipped until about ${verdict.until.toLocaleTimeString()}` : ""}; using ${next}`);
        continue;
      }

      if (sessionKey && code < 400) sessions.set(sessionKey, model);
      const extra = { "x-dshproxy-model": model };
      if (forced && model !== forced) extra["x-dshproxy-fallback"] = forced;
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
