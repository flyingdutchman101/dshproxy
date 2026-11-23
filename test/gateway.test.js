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

async function startGateway(t, backendPort, { lanes = LANES, now, supportsImages = null, resolve = null, accountOf = null, retryDelays = [], quotaReset = null, quotaLookupMs = undefined } = {}) {
  const logs = [];
  const failover = createFailover(now ? { now } : {});
  const gateway = createGateway({
    upstream: { host: "127.0.0.1", port: backendPort },
    resolve: resolve || ((id) => (id.startsWith("lane-") ? { lane: id.slice(5), ladder: lanes[id.slice(5)] || [] } : { lane: null, ladder: [id] })),
    describe: (model) => (EFFORTS[model] ? { efforts: EFFORTS[model] } : {}),
    failover,
    quotaReset: quotaReset || undefined,
    quotaLookupMs,
    sessions: createSessions(),
    log: (line) => logs.push(line),
    status: () => ({ ok: true }),
    supportsImages: supportsImages || undefined,
    accountOf: accountOf || (() => null),
    retryDelays
  });
  const port = await listen(gateway);
  t.after(() => {
    gateway.closeAllConnections();
    gateway.close();
  });
  return { url: `http://127.0.0.1:${port}`, logs, failover };
}

const post = (url, body, headers = {}, signal = undefined) => fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body), signal });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("gateway receipt distinguishes forced refusals, lane failover, and local rejection", async (t) => {
  const forged = { "x-dshproxy-receipt": "not gateway evidence" };
  const backend = await startBackend(t, model => ({ status: model === "gpt-6-astra" ? 429 : 200, headers: forged, body: { model } }));
  const { url } = await startGateway(t, backend.port, { accountOf: () => "private@example.invalid" });
  for (const [requested, mode, forwarded, attempts, status] of [
    ["gpt-6-astra", "forced", "gpt-6-astra", 1, 429],
    ["lane-main", "lane", "claude-fable-5-2", 1, 200], // previous refusal cooled the first rung
    ["lane-empty", "lane", null, 0, 503]
  ]) {
    const res = await post(url, { model: requested });
    assert.equal(res.status, status);
    const r = JSON.parse(res.headers.get("x-dshproxy-receipt"));
    assert.deepEqual([r.requested, r.mode, r.forwarded, r.attempts], [requested, mode, forwarded, attempts]);
    assert.equal(r.confirmedModel, null);
    if (attempts) assert.match(r.configuredAccount, /^acct-[a-f0-9]{16}$/);
    else assert.equal(r.configuredAccount, null);
    await res.arrayBuffer();
  }
  assert.deepEqual(backend.seen.map(v => v.model), ["gpt-6-astra", "claude-fable-5-2"]);
});

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
  assert.deepEqual(JSON.parse(response.headers.get("x-dshproxy-receipt")), { version: 1, requested: "lane-main", mode: "lane", forwarded: "claude-fable-5-2", attempts: 2, configuredAccount: null, confirmedModel: null });
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

test("a forced model runs exactly as picked", async (t) => {
  const backend = await startBackend(t, (model) => ({ status: 200, body: { served: model } }));
  const { url } = await startGateway(t, backend.port);
  const response = await post(url, { model: "gemini-4-carbon-high", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-dshproxy-model"), "gemini-4-carbon-high");
  assert.equal(response.headers.get("x-dshproxy-fallback"), null);
  assert.deepEqual(backend.seen.map((request) => request.model), ["gemini-4-carbon-high"]);
});

test("a forced model that is out of quota returns its error and runs nothing else", async (t) => {
  const backend = await startBackend(t, (model) => (model === "gemini-4-carbon-high" ? { status: 200, body: { served: model } } : { status: 429, body: { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } } }));
  const { url } = await startGateway(t, backend.port);
  const response = await post(url, { model: "gemini-3.8-flash-high", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.code, 429);
  assert.match(body.error.message, /Resource has been exhausted/);
  // The pick was the only model tried, even though a sibling would have worked.
  assert.deepEqual(backend.seen.map((request) => request.model), ["gemini-3.8-flash-high"]);
});

test("a lane still fails over, and skips an account that is rate-limiting", async (t) => {
  const accounts = { "gpt-6-astra": "codex", "gemini-a": "google", "gemini-b": "google", "gemini-c": "google", "claude-x": "claude" };
  const backend = await startBackend(t, (model) => (model === "claude-x" ? { status: 200, body: { served: model } } : { status: 429, body: { error: { message: "Resource has been exhausted (e.g. check quota)." } } }));
  const ladder = ["gpt-6-astra", "gemini-a", "gemini-b", "gemini-c", "claude-x"];
  const { url, logs } = await startGateway(t, backend.port, {
    lanes: { mixed: ladder },
    accountOf: (model) => accounts[model] || null
  });
  const first = await post(url, { model: "lane-mixed", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-dshproxy-model"), "claude-x");
  assert.match(logs.join("\n"), /account google is rate-limiting/);
  const seenBefore = backend.seen.length;
  const second = await post(url, { model: "lane-mixed", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(second.status, 200);
  // The cooling Google account was not touched again.
  const touched = backend.seen.slice(seenBefore).filter((request) => request.model.startsWith("gemini-"));
  assert.deepEqual(touched, []);
});

test("a forced model is retried after a throttle instead of failing at once", async (t) => {
  let calls = 0;
  const backend = await startBackend(t, () => {
    calls += 1;
    return calls === 1
      ? { status: 429, body: { error: { message: "Resource has been exhausted (e.g. check quota)." } } }
      : { status: 200, body: { served: "gemini-4-carbon-high" } };
  });
  const { url, logs } = await startGateway(t, backend.port, { retryDelays: [20] });
  const response = await post(url, { model: "gemini-4-carbon-high", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { served: "gemini-4-carbon-high" });
  assert.deepEqual(backend.seen.map((request) => request.model), ["gemini-4-carbon-high", "gemini-4-carbon-high"]);
  assert.match(logs.join("\n"), /retrying the same model/);
});

test("a forced model gives up after the retries are spent, with its own error", async (t) => {
  const backend = await startBackend(t, () => ({ status: 429, body: { error: { message: "Resource has been exhausted (e.g. check quota)." } } }));
  const { url } = await startGateway(t, backend.port, { retryDelays: [10, 10] });
  const response = await post(url, { model: "gemini-4-carbon-high", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 429);
  assert.equal(backend.seen.length, 3, "one attempt plus two retries");
});

// ---- A quota that is used up, as opposed to a short throttle ----

const QUOTA_BODY = { error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." } };
const HOUR = 60 * 60 * 1000;

test("a forced model whose provider names a far reset fails at once, with the provider's answer", async (t) => {
  // ChatGPT's answer to a used-up weekly limit on 2026-11-18.
  const backend = await startBackend(t, () => ({ status: 429, headers: { "retry-after": "66163" }, body: QUOTA_BODY }));
  const { url, logs } = await startGateway(t, backend.port, { retryDelays: [400, 400] });
  const started = Date.now();
  const response = await post(url, { model: "gpt-6-astra", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "66163");
  assert.deepEqual(await response.json(), QUOTA_BODY);
  assert.equal(backend.seen.length, 1, "the provider is asked once");
  assert.ok(Date.now() - started < 350, "no pause before the answer");
  assert.match(logs.join("\n"), /not retrying/);
});

test("a forced model whose provider names a near reset is still retried", async (t) => {
  let calls = 0;
  const backend = await startBackend(t, () => {
    calls += 1;
    return calls === 1 ? { status: 429, headers: { "retry-after": "1" }, body: QUOTA_BODY } : { status: 200, body: { served: "gpt-6-astra" } };
  });
  // The pauses left (1.2 s) reach past the second the provider asked for.
  const { url } = await startGateway(t, backend.port, { retryDelays: [600, 600] });
  const response = await post(url, { model: "gpt-6-astra", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 200);
  assert.equal(backend.seen.length, 2);
});

test("a forced model the usage report shows as used up is not retried, and is not looked up twice", async (t) => {
  // Claude's answer to a used-up weekly limit carries no time at all.
  const backend = await startBackend(t, () => ({ status: 429, body: QUOTA_BODY }));
  const asked = [];
  const reset = Date.now() + 27 * HOUR;
  const { url, failover } = await startGateway(t, backend.port, {
    retryDelays: [30, 30, 30],
    quotaReset: async (model) => {
      asked.push(model);
      return reset;
    }
  });
  const first = await post(url, { model: "claude-fable-5-2", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(first.status, 429);
  assert.deepEqual(await first.json(), QUOTA_BODY);
  assert.equal(backend.seen.length, 1, "the provider is asked once");
  // The model is checked again within the hour, not left alone for a day.
  const until = failover.coolingUntil("claude-fable-5-2").getTime();
  assert.ok(until > Date.now() + 55 * 60 * 1000 && until <= Date.now() + HOUR, "cools for an hour");

  const second = await post(url, { model: "claude-fable-5-2", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(second.status, 429);
  assert.equal(backend.seen.length, 2, "one more call for the second request");
  assert.deepEqual(asked, ["claude-fable-5-2"], "the usage report is read once");
});

test("a forced model is retried as before when the usage report has nothing to say", async (t) => {
  for (const quotaReset of [async () => null, async () => { throw new Error("usage endpoint is down"); }, async () => Date.now() - 1000, () => new Promise(() => {})]) {
    let calls = 0;
    const backend = await startBackend(t, () => {
      calls += 1;
      return calls === 1 ? { status: 429, body: QUOTA_BODY } : { status: 200, body: { served: "claude-fable-5-2" } };
    });
    const { url } = await startGateway(t, backend.port, { retryDelays: [20], quotaReset, quotaLookupMs: 60 });
    const response = await post(url, { model: "claude-fable-5-2", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.status, 200);
    assert.equal(backend.seen.length, 2);
  }
});

test("only a 429 is looked up in the usage report", async (t) => {
  const backend = await startBackend(t, () => ({ status: 503, body: { error: { message: "overloaded" } } }));
  let asked = 0;
  const { url } = await startGateway(t, backend.port, { retryDelays: [10], quotaReset: async () => { asked += 1; return Date.now() + HOUR; } });
  const response = await post(url, { model: "claude-fable-5-2", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 503);
  assert.equal(backend.seen.length, 2, "one attempt plus one retry");
  assert.equal(asked, 0);
});

test("a lane moves on at once and leaves a used-up model alone until it is checked again", async (t) => {
  const backend = await startBackend(t, (model) => (model === "claude-fable-5-2" ? { status: 429, body: QUOTA_BODY } : { status: 200, body: { served: model } }));
  const { url, failover } = await startGateway(t, backend.port, {
    lanes: { deep: ["claude-fable-5-2", "claude-opus-5-5"] },
    quotaReset: async (model) => (model === "claude-fable-5-2" ? Date.now() + 27 * HOUR : null)
  });
  const response = await post(url, { model: "lane-deep", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-dshproxy-model"), "claude-opus-5-5");
  await pause(30);
  const until = failover.coolingUntil("claude-fable-5-2").getTime();
  assert.ok(until > Date.now() + 55 * 60 * 1000 && until <= Date.now() + HOUR, "cools for an hour, not the ten-minute guess");
});

test("a slow usage report does not stretch the pause before a retry", async (t) => {
  let calls = 0;
  const backend = await startBackend(t, () => {
    calls += 1;
    return calls === 1 ? { status: 429, body: QUOTA_BODY } : { status: 200, body: { served: "claude-fable-5-2" } };
  });
  const { url } = await startGateway(t, backend.port, { retryDelays: [20], quotaReset: () => new Promise(() => {}), quotaLookupMs: 1500 });
  const started = Date.now();
  const response = await post(url, { model: "claude-fable-5-2", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 200);
  assert.ok(Date.now() - started < 1000, `answered after ${Date.now() - started} ms`);
});
