const http = require("http");
const { prepareBody } = require("./request");
const { needsBody } = require("./failover");

// The HTTP server DeepSeek Harness talks to. It forwards everything to
// CLIProxyAPI and adds one thing: a request for a lane is tried on each rung
// of the lane's ladder until one serves it.

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"];
const STATUS_PATH = "/dshgate/status";
// Error replies are small. Anything larger is passed on without being judged.
const MAX_JUDGED_BYTES = 64 * 1024;

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

// `resolve(modelId)` returns { lane, ladder }: the lane name (or null) and the
// models to try in order. `describe(model)` returns { efforts, upstream } for
// a model the catalog knows, or {} otherwise. `sessions` keeps a conversation
// on the rung that served it.
function createGateway({ upstream, resolve, describe = () => ({}), failover, sessions = null, log = () => {}, status = () => ({}) }) {
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
    const headers = { ...req.headers };
    for (const name of HOP_BY_HOP) delete headers[name];

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
      res.writeHead(upstreamRes.statusCode || 502, { ...upstreamRes.headers, ...extra });
      if (read) for (const chunk of read) res.write(chunk);
      if (upstreamRes.readableEnded) res.end();
      else {
        upstreamRes.pipe(res);
        upstreamRes.resume();
      }
    };
    const unreachable = (error) => {
      log(`backend did not answer: ${error.message}`);
      sendJson(res, 502, { error: { type: "dshgate_backend_unreachable", message: `dshgate could not reach its backend: ${error.message}` } });
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
        unreachable(error);
      }
      return;
    }

    const route = resolve(parsed.model);
    const label = route.lane ? `lane ${route.lane}` : parsed.model;
    if (!route.ladder.length) {
      log(`${label}: no rung is available`);
      sendJson(res, 503, { error: { type: "dshgate_no_rung", message: `No model on lane "${route.lane}" is available. Sign in to an account or add an API key, then check \`dshgate status\`.` } });
      return;
    }

    // A conversation stays on the rung that last served it, while that rung is
    // still serving.
    let rungs = failover.order(route.ladder);
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
        const verdict = failover.report(model, 0);
        if (verdict.failover && next && !res.destroyed) {
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
      if (next && needsBody(code) && !upstreamRes.headers["content-encoding"]) {
        read = [];
        const whole = await readSmall(upstreamRes, read);
        if (whole) text = whole.toString("utf8");
      }

      const verdict = failover.report(model, code, upstreamRes.headers["retry-after"], text);
      if (verdict.failover && next && !res.destroyed) {
        if (!read) upstreamRes.resume();
        log(`${label}: ${model} ${verdict.reason}${verdict.until ? `, skipped until about ${verdict.until.toLocaleTimeString()}` : ""}; using ${next}`);
        continue;
      }

      if (sessionKey && code < 400) sessions.set(sessionKey, model);
      const extra = { "x-dshgate-model": model };
      if (route.lane) extra["x-dshgate-lane"] = route.lane;
      relay(upstreamRes, extra, read);
      return;
    }
  }

  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === STATUS_PATH) {
      sendJson(res, 200, status());
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", () => res.destroy());
    req.on("end", () => {
      handle(req, res, Buffer.concat(chunks)).catch((error) => {
        log(`request failed: ${error.message}`);
        sendJson(res, 500, { error: { type: "dshgate_internal", message: error.message } });
      });
    });
  });
}

module.exports = { createGateway, STATUS_PATH };
