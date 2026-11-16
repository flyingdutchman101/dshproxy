const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const zlib = require("zlib");

const { createGateway } = require("../src/gateway/server");
const { createFailover } = require("../src/gateway/failover");
const { createSessions } = require("../src/gateway/sessions");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// A stand-in for CLIProxyAPI. `answer(model, request)` returns
// { status, headers, body } or { status, chunks } for a streamed reply.
async function startBackend(t, answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      let model = null;
      try {
        model = JSON.parse(raw.toString("utf8")).model;
      } catch {
        model = null;
      }
      const request = { method: req.method, url: req.url, headers: req.headers, raw, model };
      seen.push(request);
      const reply = answer(model, request);
      // `hang`: never answer. `truncate`: drop the connection part-way.
      // `gzip`: compress the body when the request allows it.
      if (reply.hang) return;
      const headers = { "content-type": "application/json", ...(reply.headers || {}) };
      if (reply.truncate) {
        res.writeHead(reply.status, headers);
        res.write(reply.chunks[0]);
        setTimeout(() => req.socket.destroy(), 50);
        return;
      }
      if (reply.chunks) {
        res.writeHead(reply.status, headers);
        for (const chunk of reply.chunks) res.write(chunk);
        res.end();
        return;
      }
      let payload = Buffer.from(JSON.stringify(reply.body ?? {}));
      if (reply.gzip && /gzip/.test(String(req.headers["accept-encoding"] || ""))) {
        payload = zlib.gzipSync(payload);
        headers["content-encoding"] = "gzip";
      }
      res.writeHead(reply.status, headers);
      res.end(payload);
    });
  });
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port, seen };
}

const LANES = { main: ["gpt-6-astra", "claude-fable-5-2", "gemini-4-carbon-high"], empty: [] };
const EFFORTS = { "gemini-4-carbon-high": ["high"] };

async function startGateway(t, backendPort, { lanes = LANES, now, supportsImages = null, resolve = null } = {}) {
  const logs = [];
  const gateway = createGateway({
    upstream: { host: "127.0.0.1", port: backendPort },
    resolve: resolve || ((id) => (id.startsWith("lane-") ? { lane: id.slice(5), ladder: lanes[id.slice(5)] || [] } : { lane: null, ladder: [id] })),
    describe: (model) => (EFFORTS[model] ? { efforts: EFFORTS[model] } : {}),
    failover: createFailover(now ? { now } : {}),
    sessions: createSessions(),
    log: (line) => logs.push(line),
    status: () => ({ ok: true }),
    supportsImages: supportsImages || undefined
  });
  const port = await listen(gateway);
  t.after(() => {
    gateway.closeAllConnections();
    gateway.close();
  });
  return { url: `http://127.0.0.1:${port}`, logs };
}

const post = (url, body, headers = {}, signal = undefined) => fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body), signal });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a lane request is served by the first rung", async (t) => {
  const backend = await startBackend(t, (model) => ({ status: 200, body: { served: model } }));
  const { url } = await startGateway(t, backend.port);
  const response = await post(url, { model: "lane-main", max_tokens: 5 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { served: "gpt-6-astra" });
  assert.equal(response.headers.get("x-dshproxy-model"), "gpt-6-astra");
  assert.equal(response.headers.get("x-dshproxy-lane"), "main");
});

test("a rung that is out of quota is skipped and the next rung serves the same request", async (t) => {
  const backend = await startBackend(t, (model) => (model === "gpt-6-astra" ? { status: 429, body: { error: "quota" } } : { status: 200, body: { served: model } }));
  const { url, logs } = await startGateway(t, backend.port);
  const response = await post(url, { model: "lane-main", messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { served: "claude-fable-5-2" });
  assert.deepEqual(backend.seen.map((request) => request.model), ["gpt-6-astra", "claude-fable-5-2"]);
  assert.deepEqual(JSON.parse(backend.seen[1].raw.toString("utf8")).messages, [{ role: "user", content: "hi" }]);
  assert.ok(logs.some((line) => line.includes("gpt-6-astra") && line.includes("claude-fable-5-2")), "the move is logged");
});

test("the next request goes straight to the rung that is still serving", async (t) => {
  const backend = await startBackend(t, (model) => (model === "gpt-6-astra" ? { status: 429 } : { status: 200, body: { served: model } }));
  const { url } = await startGateway(t, backend.port);
  await (await post(url, { model: "lane-main" })).arrayBuffer();
  backend.seen.length = 0;
  const response = await post(url, { model: "lane-main" });
  assert.deepEqual(await response.json(), { served: "claude-fable-5-2" });
  assert.deepEqual(backend.seen.map((request) => request.model), ["claude-fable-5-2"]);
});

const session = (first, extra = []) => ({ model: "lane-main", messages: [{ role: "user", content: first }, ...extra] });

test("a session that moved to a backup rung stays there after the first rung recovers; a new session starts on the first rung", async (t) => {
  const clock = { time: Date.parse("2026-11-15T12:00:00Z") };
  let astraExhausted = true;
  const backend = await startBackend(t, (model) => (model === "gpt-6-astra" && astraExhausted ? { status: 429 } : { status: 200, body: { served: model } }));
  const { url } = await startGateway(t, backend.port, { now: () => clock.time });

  assert.deepEqual(await (await post(url, session("build the parser"))).json(), { served: "claude-fable-5-2" });

  // The first rung has quota again and its cool-down is over.
  astraExhausted = false;
  clock.time += 11 * 60 * 1000;
  const followUp = session("build the parser", [{ role: "assistant", content: "done" }, { role: "user", content: "now add tests" }]);
  assert.deepEqual(await (await post(url, followUp)).json(), { served: "claude-fable-5-2" });
  assert.deepEqual(await (await post(url, session("a different task"))).json(), { served: "gpt-6-astra" });
});

test("a session whose rung runs out moves on and stays on the rung that took over", async (t) => {
  const exhausted = new Set();
  const backend = await startBackend(t, (model) => (exhausted.has(model) ? { status: 429 } : { status: 200, body: { served: model } }));
  const { url } = await startGateway(t, backend.port);
  assert.deepEqual(await (await post(url, session("task"))).json(), { served: "gpt-6-astra" });
  exhausted.add("gpt-6-astra");
  assert.deepEqual(await (await post(url, session("task"))).json(), { served: "claude-fable-5-2" });
  exhausted.delete("gpt-6-astra");
  assert.deepEqual(await (await post(url, session("task"))).json(), { served: "claude-fable-5-2" });
});

test("a request too long for one rung is tried on the next, and the rung stays in use for other requests", async (t) => {
  const backend = await startBackend(t, (model, request) => {
    const long = request.raw.includes("LONG");
    return model === "gpt-6-astra" && long ? { status: 400, body: { error: { message: "context_length_exceeded: maximum context length is 272000 tokens" } } } : { status: 200, body: { served: model } };
  });
  const { url } = await startGateway(t, backend.port);
  assert.deepEqual(await (await post(url, session("LONG prompt"))).json(), { served: "claude-fable-5-2" });
  assert.deepEqual(await (await post(url, session("short prompt"))).json(), { served: "gpt-6-astra" });
});

test("a rung the account does not serve is skipped", async (t) => {
  const backend = await startBackend(t, (model) => (model === "gpt-6-astra" ? { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "unknown provider for model gpt-6-astra" } } } : { status: 200, body: { served: model } }));
  const { url } = await startGateway(t, backend.port);
  assert.deepEqual(await (await post(url, session("one"))).json(), { served: "claude-fable-5-2" });
  backend.seen.length = 0;
  await (await post(url, session("two"))).arrayBuffer();
  assert.deepEqual(backend.seen.map((request) => request.model), ["claude-fable-5-2"]);
});

test("a too-long request on the last rung returns that rung's own error", async (t) => {
  const backend = await startBackend(t, () => ({ status: 400, body: { error: { message: "prompt is too long: 1200000 tokens > 1000000 maximum" } } }));
  const { url } = await startGateway(t, backend.port);
  const response = await post(url, session("LONG"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { message: "prompt is too long: 1200000 tokens > 1000000 maximum" } });
  assert.equal(backend.seen.length, 3);
});

test("a rejected request is returned to the caller without trying another model", async (t) => {
  const backend = await startBackend(t, () => ({ status: 400, body: { error: { message: "tools.0.input_schema: field required" } } }));
  const { url } = await startGateway(t, backend.port);
  const response = await post(url, { model: "lane-main" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { message: "tools.0.input_schema: field required" } });
  assert.equal(backend.seen.length, 1);
});

test("a client that gives up waiting does not count against the model", async (t) => {
  let hang = true;
  const backend = await startBackend(t, (model) => (hang ? { hang: true } : { status: 200, body: { served: model } }));
  const { url } = await startGateway(t, backend.port);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(post(url, session(`task ${attempt}`), {}, AbortSignal.timeout(150)));
  }
  await pause(100);
  hang = false;
  assert.deepEqual(await (await post(url, session("a new task"))).json(), { served: "gpt-6-astra" });
});

test("a reply cut off part-way ends the client's request instead of leaving it waiting", async (t) => {
  const backend = await startBackend(t, () => ({ status: 200, truncate: true, headers: { "content-type": "text/event-stream" }, chunks: ['event: message_start\ndata: {"type":"message_start"}\n\n'] }));
  const { url } = await startGateway(t, backend.port);
  const response = await post(url, { model: "lane-main", stream: true });
  let timer;
  const outcome = await Promise.race([
    response.text().then(() => "ended normally", () => "failed"),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("still waiting"), 3000);
    })
  ]);
  clearTimeout(timer);
  assert.equal(outcome, "failed");
});

test("a compressed rejection is judged like a plain one", async (t) => {
  const tooLong = { error: { message: "prompt is too long: 300000 tokens > 272000 maximum" } };
  const backend = await startBackend(t, (model) => (model === "gpt-6-astra" ? { status: 400, gzip: true, body: tooLong } : { status: 200, body: { served: model } }));
  const { url } = await startGateway(t, backend.port);
  const response = await post(url, session("LONG prompt"), { "accept-encoding": "gzip" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { served: "claude-fable-5-2" });
});

test("a server error is returned to the caller twice; the third moves to the next rung", async (t) => {
  const backend = await startBackend(t, (model) => (model === "gpt-6-astra" ? { status: 502, body: { error: "bad gateway" } } : { status: 200, body: { served: model } }));
  const { url } = await startGateway(t, backend.port);
  for (const name of ["one", "two"]) {
    const response = await post(url, session(name));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "bad gateway" });
  }
  const third = await post(url, session("three"));
  assert.equal(third.status, 200);
  assert.deepEqual(await third.json(), { served: "claude-fable-5-2" });
});

test("connection-level headers from the backend are not passed on", async (t) => {
  const backend = await startBackend(t, () => ({ status: 200, headers: { "proxy-connection": "keep-alive", "x-request-id": "abc" }, body: { ok: true } }));
  const { url } = await startGateway(t, backend.port);
  const response = await post(url, { model: "claude-opus-5-5" });
  assert.equal(response.headers.get("proxy-connection"), null);
  assert.equal(response.headers.get("x-request-id"), "abc");
  assert.deepEqual(await response.json(), { ok: true });
});

test("a request over the size limit is refused before it reaches the backend", async (t) => {
  const backend = await startBackend(t, () => ({ status: 200, body: {} }));
  const gateway = createGateway({
    upstream: { host: "127.0.0.1", port: backend.port },
    resolve: (id) => ({ lane: null, ladder: [id] }),
    failover: createFailover(),
    maxBodyBytes: 1024
  });
  const port = await listen(gateway);
  t.after(() => {
    gateway.closeAllConnections();
    gateway.close();
  });
  const response = await post(`http://127.0.0.1:${port}`, { model: "claude-opus-5-5", padding: "x".repeat(4096) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.type, "dshproxy_request_too_large");
  assert.equal(backend.seen.length, 0);
});

test("a rejection too large to judge is returned whole", async (t) => {
  // Larger than the gateway reads to judge a rejection, and it would count as
  // "too long" if it were judged.
  const big = { error: { message: "prompt is too long" }, padding: "x".repeat(200 * 1024) };
  const backend = await startBackend(t, () => ({ status: 400, body: big }));
  const { url } = await startGateway(t, backend.port);
  const response = await post(url, { model: "lane-main" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), big);
  assert.equal(backend.seen.length, 1);
});

test("when the last rung is also out of quota its answer is returned", async (t) => {
  const backend = await startBackend(t, (model) => ({ status: 429, headers: { "retry-after": "60" }, body: { error: `${model} exhausted` } }));
  const { url } = await startGateway(t, backend.port);
  const response = await post(url, { model: "lane-main" });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "gemini-4-carbon-high exhausted" });
  assert.equal(backend.seen.length, 3);
});

test("a lane with no available model answers 503 and names the lane", async (t) => {
  const backend = await startBackend(t, () => ({ status: 200 }));
  const { url } = await startGateway(t, backend.port);
  const response = await post(url, { model: "lane-empty" });
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error.type, "dshproxy_no_rung");
  assert.match(payload.error.message, /"empty"/);
  assert.equal(backend.seen.length, 0);
});

test("a request for a real model reaches the backend byte for byte", async (t) => {
  const backend = await startBackend(t, () => ({ status: 200, body: { ok: true } }));
  const { url } = await startGateway(t, backend.port);
  const raw = '{ "stream":false,   "model":"claude-opus-5-5", "messages":[] }';
  const response = await post(url, raw, { "anthropic-beta": "context-1m-2025-08-07", "x-api-key": "client-key" });
  assert.equal(response.status, 200);
  assert.equal(backend.seen[0].raw.toString("utf8"), raw);
  assert.equal(backend.seen[0].headers["anthropic-beta"], "context-1m-2025-08-07");
  assert.equal(backend.seen[0].headers["x-api-key"], "client-key");
  assert.equal(backend.seen[0].url, "/v1/messages");
});

test("a real model that is out of quota returns its own answer", async (t) => {
  const backend = await startBackend(t, () => ({ status: 429, body: { error: "quota" } }));
  const { url } = await startGateway(t, backend.port);
  const response = await post(url, { model: "claude-opus-5-5" });
  assert.equal(response.status, 429);
  assert.equal(backend.seen.length, 1);
});

test("the reasoning level is mapped to one the serving rung accepts", async (t) => {
  const backend = await startBackend(t, (model) => (model === "gemini-4-carbon-high" ? { status: 200, body: {} } : { status: 503 }));
  const { url } = await startGateway(t, backend.port);
  await (await post(url, { model: "lane-main", reasoning_effort: "xhigh" })).arrayBuffer();
  const served = backend.seen[backend.seen.length - 1];
  assert.equal(served.model, "gemini-4-carbon-high");
  assert.equal(JSON.parse(served.raw.toString("utf8")).reasoning_effort, "high");
  // Rungs without a declared level set receive what the client sent.
  assert.equal(JSON.parse(backend.seen[0].raw.toString("utf8")).reasoning_effort, "xhigh");
});

test("a streamed reply passes through unchanged", async (t) => {
  const events = ['event: message_start\ndata: {"type":"message_start"}\n\n', 'event: message_stop\ndata: {"type":"message_stop"}\n\n'];
  const backend = await startBackend(t, () => ({ status: 200, headers: { "content-type": "text/event-stream" }, chunks: events }));
  const { url } = await startGateway(t, backend.port);
  const response = await post(url, { model: "lane-main", stream: true });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(await response.text(), events.join(""));
});

test("requests without a model, such as the model list, are forwarded as they are", async (t) => {
  const backend = await startBackend(t, () => ({ status: 200, body: { data: [{ id: "gpt-6-astra" }] } }));
  const { url } = await startGateway(t, backend.port);
  const response = await fetch(`${url}/v1/models`);
  assert.deepEqual(await response.json(), { data: [{ id: "gpt-6-astra" }] });
  assert.equal(backend.seen[0].method, "GET");
  assert.equal(backend.seen[0].url, "/v1/models");
});

test("a backend that is down answers 502 instead of hanging", async (t) => {
  const closed = http.createServer();
  const port = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  const { url } = await startGateway(t, port);
  const response = await post(url, { model: "claude-opus-5-5" });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.type, "dshproxy_backend_unreachable");
});

test("the status page is answered by the gateway itself", async (t) => {
  const backend = await startBackend(t, () => ({ status: 200 }));
  const { url } = await startGateway(t, backend.port);
  assert.deepEqual(await (await fetch(`${url}/dshproxy/status`)).json(), { ok: true });
  assert.equal(backend.seen.length, 0);
});

test("an image request skips text-only rungs on a lane", async (t) => {
  const backend = await startBackend(t, (model) => ({ status: 200, body: { served: model } }));
  const { url } = await startGateway(t, backend.port, { supportsImages: (model) => model !== "gpt-6-astra" });
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } };
  const response = await post(url, { model: "lane-main", max_tokens: 5, messages: [{ role: "user", content: [image] }] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { served: "claude-fable-5-2" });
  assert.deepEqual(backend.seen.map((request) => request.model), ["claude-fable-5-2"]);
});

test("an image on a lane with no image-capable rung is refused before anything is sent", async (t) => {
  const backend = await startBackend(t, (model) => ({ status: 200, body: { served: model } }));
  const { url } = await startGateway(t, backend.port, { supportsImages: () => false });
  const response = await post(url, { model: "lane-main", messages: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAA" }] }] });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.type, "dshproxy_no_image_rung");
  assert.match(body.error.message, /accepts images/);
  assert.equal(backend.seen.length, 0);
});

test("a forced model is served by a sibling when it is out of quota", async (t) => {
  const backend = await startBackend(t, (model) =>
    model === "gemini-4-carbon-high"
      ? { status: 200, body: { served: model } }
      : { status: 429, body: { error: { message: "Resource has been exhausted (e.g. check quota)." } } });
  const { url, logs } = await startGateway(t, backend.port, {
    resolve: (id) => (id === "gemini-3.8-flash-high"
      ? { lane: null, ladder: [id], fallbacks: ["gemini-4-carbon-high"] }
      : { lane: null, ladder: [id] })
  });
  const response = await post(url, { model: "gemini-3.8-flash-high", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { served: "gemini-4-carbon-high" });
  assert.equal(response.headers.get("x-dshproxy-model"), "gemini-4-carbon-high");
  assert.equal(response.headers.get("x-dshproxy-fallback"), "gemini-3.8-flash-high");
  assert.deepEqual(backend.seen.map((request) => request.model), ["gemini-3.8-flash-high", "gemini-4-carbon-high"]);
  assert.match(logs.join("\n"), /gemini-3\.8-flash-high returned HTTP 429.*using gemini-4-carbon-high/);
});

test("a forced model keeps its own answer when it is healthy", async (t) => {
  const backend = await startBackend(t, (model) => ({ status: 200, body: { served: model } }));
  const { url } = await startGateway(t, backend.port, {
    resolve: (id) => (id === "gemini-3.8-flash-high" ? { lane: null, ladder: [id], fallbacks: ["gemini-4-carbon-high"] } : { lane: null, ladder: [id] })
  });
  const response = await post(url, { model: "gemini-3.8-flash-high", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-dshproxy-model"), "gemini-3.8-flash-high");
  assert.equal(response.headers.get("x-dshproxy-fallback"), null);
  assert.deepEqual(backend.seen.map((request) => request.model), ["gemini-3.8-flash-high"]);
});

test("a bad request from a forced model is not retried on a sibling", async (t) => {
  const backend = await startBackend(t, () => ({ status: 400, body: { error: { message: "invalid request" } } }));
  const { url } = await startGateway(t, backend.port, {
    resolve: (id) => (id === "gemini-3.8-flash-high" ? { lane: null, ladder: [id], fallbacks: ["gemini-4-carbon-high"] } : { lane: null, ladder: [id] })
  });
  const response = await post(url, { model: "gemini-3.8-flash-high", messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 400);
  assert.deepEqual(backend.seen.map((request) => request.model), ["gemini-3.8-flash-high"]);
});
test("a forced image request does not fall back to a text-only sibling", async (t) => {
  const backend = await startBackend(t, (model) => (model === "gemini-4-carbon-high" ? { status: 200, body: { served: model } } : { status: 429, body: { error: { message: "Resource has been exhausted (e.g. check quota)." } } }));
  const { url } = await startGateway(t, backend.port, {
    supportsImages: (model) => model === "gemini-3.8-flash-high" || model === "gemini-4-carbon-high",
    resolve: (id) => (id === "gemini-3.8-flash-high" ? { lane: null, ladder: [id], fallbacks: ["gemini-4-carbon-high", "gpt-6-astra"] } : { lane: null, ladder: [id] })
  });
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } };
  const response = await post(url, { model: "gemini-3.8-flash-high", max_tokens: 5, messages: [{ role: "user", content: [image] }] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-dshproxy-model"), "gemini-4-carbon-high");
  // The forced model was tried first, then its vision-capable sibling; the
  // text-only model was never sent an image.
  assert.deepEqual(backend.seen.map((request) => request.model), ["gemini-3.8-flash-high", "gemini-4-carbon-high"]);
});
