const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// Nothing here may reach the real data folder, the DeepSeek Harness profiles,
// the network, a real backend program or a gateway already running on this
// machine. Every folder is a throwaway one, every port a spare loopback port,
// and anything that asks for another address fails.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-daemon-test-"));
process.env.DSHPROXY_HOME = path.join(sandbox, "default-home-stays-unused");
process.env.DSH_HOME = path.join(sandbox, "no-deepseek-harness");
const ports = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const target = new URL(String(url));
  if (target.hostname !== "127.0.0.1" || !ports.has(Number(target.port))) throw new Error(`network is forbidden in this test: ${target.origin}`);
  return realFetch(url, options);
};
test.after(() => {
  try {
    assert.equal(fs.existsSync(process.env.DSHPROXY_HOME), false);
    assert.equal(fs.existsSync(process.env.DSH_HOME), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

const daemon = require("../src/daemon");
const { stopForRestart } = require("../src/cli");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "dshproxy.js");
// The ports of the gateway that serves this machine. No test may use them.
const LIVE_PORTS = [8417, 8418];

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await pause(5);
  }
}

async function sparePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(!LIVE_PORTS.includes(port));
  ports.add(port);
  return port;
}

// A stand-in for CLIProxyAPI. The query of a request (or its x-how and x-id
// headers) says how it is answered: how=ok at once, how=hold nothing until the
// test finishes it, how=stream the headers and a first part and the rest when
// the test finishes it, how=cut a first part and then the connection is dropped.
async function startBackend(t) {
  const held = new Map();
  const seen = [];
  const server = http.createServer((req, res) => {
    res.on("error", () => {});
    req.on("error", () => {});
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://backend");
      const how = url.searchParams.get("how") || req.headers["x-how"] || "ok";
      const id = url.searchParams.get("id") || req.headers["x-id"] || `request-${seen.length}`;
      seen.push({ method: req.method, url: req.url, id, body: Buffer.concat(chunks).toString("utf8") });
      if (how === "ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ served: id }));
        return;
      }
      if (how === "cut") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial ");
        setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      if (how === "stream") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first ");
      }
      const entry = { dropped: false, finish: (text = "last") => {
        if (how === "hold") res.writeHead(200, { "content-type": "text/plain" });
        res.end(text);
      } };
      // The gateway gave the request up before it was answered.
      res.on("close", () => { if (!res.writableEnded) entry.dropped = true; });
      held.set(id, entry);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  assert.ok(!LIVE_PORTS.includes(port));
  ports.add(port);
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  t.after(close);
  return { port, seen, close, held: (id) => until(() => held.get(id), `the backend to receive ${id}`) };
}

// The real daemon on spare ports, with the one seam it has: the backend
// program is not installed or started. `backendExitMs` stands in for the time
// the program takes to exit.
async function startGateway(t, { backendExitMs = 30, onBackendStop = null } = {}) {
  const home = fs.mkdtempSync(path.join(sandbox, "home-"));
  const backend = await startBackend(t);
  const port = await sparePort();
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ port, backendPort: backend.port }));
  const logs = [];
  const events = [];
  const supervisor = {
    start: async () => { events.push("backend started"); },
    stop: async () => {
      events.push("backend stopping");
      // Called in the very tick the gateway stops, after it closed its port.
      if (onBackendStop) onBackendStop();
      await pause(backendExitMs);
      events.push("backend exited");
    },
    state: () => ({ running: true, pid: 4242, restarts: 0 })
  };
  const gateway = await daemon.start({
    home,
    print: (line) => logs.push(line),
    exit: () => events.push("exit"),
    backend: { install: async () => ({ path: path.join(home, "no-backend-program"), installed: false }), createSupervisor: () => supervisor }
  });
  t.after(() => gateway.stop());
  const tokenFile = path.join(home, "control.token");
  return { home, port, backend, gateway, logs, events, tokenFile, token: () => fs.readFileSync(tokenFile, "utf8").trim() };
}

// One HTTP request. `done` resolves to { status, text } when the whole answer
// has arrived and rejects when it is cut or never comes.
function call(port, { method = "GET", target = "/v1/models", headers = {}, body = "", agent = false } = {}) {
  const state = { status: null, headers: null, text: "" };
  let sawPart;
  const firstPart = new Promise((resolve) => { sawPart = resolve; });
  const req = http.request({ host: "127.0.0.1", port, method, path: target, headers, agent });
  const done = new Promise((resolve, reject) => {
    req.on("error", reject);
    req.on("response", (res) => {
      let whole = false;
      state.status = res.statusCode;
      state.headers = res.headers;
      res.setEncoding("utf8");
      res.on("data", (chunk) => { state.text += chunk; sawPart(); });
      res.on("end", () => { whole = true; resolve(state); });
      res.on("error", reject);
      res.on("close", () => { if (!whole) reject(new Error("the answer was cut")); });
    });
  });
  done.catch(() => {});
  req.end(body);
  return { done, firstPart, state, destroy: () => req.destroy() };
}
const get = (port, target) => call(port, { target }).done;
const liveStatus = async (port) => JSON.parse((await get(port, "/dshproxy/status")).text);
const control = (g, name, body, { token = g.token(), headers = {} } = {}) => call(g.port, { method: "POST", target: `/dshproxy/control/${name}`, headers: { "x-dshproxy-token": token, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const refused = (port) => assert.rejects(get(port, "/dshproxy/status"), /ECONNREFUSED/);
const idle = (g) => until(() => g.gateway.inFlight() === 0, "nothing in flight");
const flying = (g, count) => until(() => g.gateway.inFlight() === count, `${count} in flight`);

// ------------------------------- requests in flight -------------------------------

test("a request is in flight from its arrival until its answer has ended, and status reports the count", async (t) => {
  const g = await startGateway(t);
  assert.equal(g.gateway.inFlight(), 0);
  assert.equal((await liveStatus(g.port)).inFlight, 0);
  assert.equal(g.gateway.status().inFlight, 0);

  const first = call(g.port, { target: "/v1/models?how=hold&id=a" });
  await g.backend.held("a");
  assert.equal((await liveStatus(g.port)).inFlight, 1);

  // A model request whose answer has begun is still in flight.
  const second = call(g.port, { method: "POST", target: "/v1/messages?how=stream&id=b", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "test-model", stream: true }) });
  await second.firstPart;
  assert.equal((await liveStatus(g.port)).inFlight, 2);
  assert.equal(g.gateway.inFlight(), 2);

  (await g.backend.held("a")).finish("whole answer");
  assert.deepEqual([(await first.done).status, first.state.text], [200, "whole answer"]);
  await flying(g, 1);
  assert.equal((await liveStatus(g.port)).inFlight, 1);

  (await g.backend.held("b")).finish("last");
  assert.equal((await second.done).text, "first last");
  await idle(g);
  assert.equal((await liveStatus(g.port)).inFlight, 0);
  assert.equal(typeof (await liveStatus(g.port)).inFlight, "number");
});

test("the gateway's own status and control requests are not counted; everything it forwards is", async (t) => {
  const g = await startGateway(t);
  for (let round = 0; round < 3; round += 1) assert.equal((await liveStatus(g.port)).inFlight, 0);
  // Control calls, accepted or refused.
  assert.equal((await control(g, "nothing", {}).done).status, 404);
  assert.equal((await control(g, "stop", {}, { token: "b".repeat(64) }).done).status, 401);
  assert.equal(g.gateway.inFlight(), 0);

  // A control call that is being held open is not in flight either.
  const held = call(g.port, { target: "/v1/models?how=hold&id=a" });
  await g.backend.held("a");
  const waiting = control(g, "stop", { waitSeconds: 30 });
  await until(() => g.logs.some((line) => /stop when idle requested/.test(line)), "the stop call to be waiting");
  assert.equal(g.gateway.inFlight(), 1);
  assert.equal((await liveStatus(g.port)).inFlight, 1);
  waiting.destroy();
  await until(() => g.logs.some((line) => /caller went away/.test(line)), "the stop call to be dropped");

  // Anything else under /dshproxy/ goes to the backend like any request.
  const other = call(g.port, { method: "POST", target: "/dshproxy/status?how=hold&id=b" });
  await g.backend.held("b");
  assert.equal(g.gateway.inFlight(), 2);
  // So does the status address itself with any method but GET.
  const posted = call(g.port, { method: "POST", target: "/dshproxy/status", headers: { "x-how": "hold", "x-id": "c" } });
  await g.backend.held("c");
  assert.equal(g.gateway.inFlight(), 3);
  (await g.backend.held("a")).finish();
  (await g.backend.held("b")).finish();
  (await g.backend.held("c")).finish("from the backend");
  await Promise.all([held.done, other.done]);
  assert.equal((await posted.done).text, "from the backend");
  await idle(g);
});

test("a request the client gives up on is no longer in flight, at whatever point it gives up", async (t) => {
  const g = await startGateway(t);

  // Before the backend has answered.
  const waiting = call(g.port, { target: "/v1/models?how=hold&id=a" });
  const a = await g.backend.held("a");
  await flying(g, 1);
  waiting.destroy();
  await idle(g);
  // The gateway still drops its own request to the backend.
  await until(() => a.dropped, "the backend request to be dropped");

  // While the answer is streaming.
  const streaming = call(g.port, { method: "POST", target: "/v1/messages?how=stream&id=b", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "test-model" }) });
  await streaming.firstPart;
  await flying(g, 1);
  streaming.destroy();
  await idle(g);

  // While the request itself is still being sent.
  const socket = net.connect(g.port, "127.0.0.1");
  socket.on("error", () => {});
  socket.write("POST /v1/messages HTTP/1.1\r\nHost: gateway\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{\"model\":");
  await flying(g, 1);
  socket.destroy();
  await idle(g);

  assert.equal((await liveStatus(g.port)).inFlight, 0);
  assert.equal((await get(g.port, "/v1/models?how=ok")).status, 200);
});

test("a request that ends because the backend fails is no longer in flight", async (t) => {
  const g = await startGateway(t);

  // The backend drops the connection part-way through its answer.
  const cut = call(g.port, { target: "/v1/models?how=cut" });
  await assert.rejects(cut.done);
  await idle(g);

  // The backend cannot be reached at all.
  g.backend.close();
  const unreachable = await get(g.port, "/v1/models?how=ok");
  assert.equal(unreachable.status, 502);
  assert.match(unreachable.text, /dshproxy_backend_unreachable/);
  await idle(g);
  assert.equal((await liveStatus(g.port)).inFlight, 0);
});

test("requests waiting behind another on one connection end with that connection", async (t) => {
  const g = await startGateway(t);
  const socket = net.connect(g.port, "127.0.0.1");
  socket.on("error", () => {});
  // Two requests sent at once: the answer to the second cannot start before
  // the first is answered, and the first is held.
  socket.write("GET /v1/models?how=hold&id=a HTTP/1.1\r\nHost: gateway\r\n\r\nGET /v1/models?how=hold&id=b HTTP/1.1\r\nHost: gateway\r\n\r\n");
  await g.backend.held("a");
  await g.backend.held("b");
  assert.equal(g.gateway.inFlight(), 2);
  socket.destroy();
  await idle(g);
});

test("many requests on one kept-open connection are each counted once and leave nothing behind", async (t) => {
  const g = await startGateway(t);
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);
  t.after(() => process.removeListener("warning", onWarning));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  let peak = 0;
  for (let round = 0; round < 40; round += 1) {
    const request = call(g.port, { target: `/v1/models?how=hold&id=r${round}`, agent });
    const entry = await g.backend.held(`r${round}`);
    peak = Math.max(peak, g.gateway.inFlight());
    assert.equal(g.gateway.inFlight(), 1);
    entry.finish();
    await request.done;
    await idle(g);
  }
  assert.equal(peak, 1);
  await pause(20);
  assert.deepEqual(warnings.map((warning) => warning.name), []);
});

// A small fixed-seed generator: the same mix on every run.
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

for (const seed of [1, 2]) {
  test(`after any mix of endings the count is what is still open, and zero at the end (seed ${seed})`, async (t) => {
    const g = await startGateway(t);
    const random = generator(seed);
    const endings = ["answered at once", "cut by the backend", "held then answered", "held then given up", "streaming then answered", "streaming then given up"];
    const open = [];
    const settled = [];
    for (let index = 0; index < 36; index += 1) {
      const ending = endings[Math.floor(random() * endings.length)];
      const id = `m${index}`;
      if (ending === "answered at once" || ending === "cut by the backend") {
        settled.push(call(g.port, { target: `/v1/models?how=${ending === "answered at once" ? "ok" : "cut"}&id=${id}` }).done.catch(() => null));
        continue;
      }
      const streaming = ending.startsWith("streaming");
      const request = call(g.port, { target: `/v1/models?how=${streaming ? "stream" : "hold"}&id=${id}` });
      open.push({ id, request, streaming, givenUp: ending.endsWith("given up") });
    }
    await Promise.all(settled);
    for (const item of open) {
      await g.backend.held(item.id);
      if (item.streaming) await item.request.firstPart;
    }
    // Everything that could end has ended; the rest is exactly what is open.
    await flying(g, open.length);
    assert.equal((await liveStatus(g.port)).inFlight, open.length);

    let left = open.length;
    while (open.length) {
      const [item] = open.splice(Math.floor(random() * open.length), 1);
      if (item.givenUp) item.request.destroy();
      else {
        (await g.backend.held(item.id)).finish();
        await item.request.done;
      }
      left -= 1;
      await flying(g, left);
    }
    await pause(20);
    assert.equal(g.gateway.inFlight(), 0);
  });
}

// ------------------------------- stop when idle -------------------------------

test("stop when idle stops at once when nothing is in flight", async (t) => {
  const g = await startGateway(t);
  assert.equal(fs.existsSync(g.tokenFile), true);
  assert.deepEqual(await g.gateway.stop({ whenIdle: true, waitMs: 5000 }), { stopped: true });
  await refused(g.port);
  assert.equal(fs.existsSync(g.tokenFile), false);
  assert.deepEqual(g.events, ["backend started", "backend stopping", "backend exited"]);
});

test("stop when idle does not cut a request in flight, keeps serving while it waits, and stops right after the request ends", async (t) => {
  const g = await startGateway(t);
  const held = call(g.port, { method: "POST", target: "/v1/messages?how=stream&id=a", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "test-model", stream: true }) });
  await held.firstPart;

  let result = null;
  const stopping = g.gateway.stop({ whenIdle: true, waitMs: 60000 }).then((value) => { result = value; return value; });
  await pause(60);
  assert.equal(result, null);

  // Still listening: new connections, new requests, status and control calls.
  assert.deepEqual(JSON.parse((await get(g.port, "/v1/models?how=ok&id=new")).text), { served: "new" });
  const second = call(g.port, { target: "/v1/models?how=hold&id=b" });
  await g.backend.held("b");
  assert.equal((await liveStatus(g.port)).inFlight, 2);
  assert.equal((await control(g, "nothing", {}).done).status, 404);
  assert.equal(fs.existsSync(g.tokenFile), true);

  // One of the two ends: not idle yet, so nothing stops.
  (await g.backend.held("b")).finish("second whole");
  assert.equal((await second.done).text, "second whole");
  await flying(g, 1);
  await pause(40);
  assert.equal(result, null);
  assert.deepEqual(g.events, ["backend started"]);
  assert.equal((await get(g.port, "/v1/models?how=ok")).status, 200);

  // The last one ends: it arrives whole, and the gateway stops.
  const endedAt = Date.now();
  (await g.backend.held("a")).finish("last");
  assert.deepEqual([(await held.done).status, held.state.text], [200, "first last"]);
  assert.deepEqual(await stopping, { stopped: true });
  assert.ok(Date.now() - endedAt < 3000, "the stop did not follow the end of the request");
  await refused(g.port);
  assert.equal(fs.existsSync(g.tokenFile), false);
  assert.deepEqual(g.events, ["backend started", "backend stopping", "backend exited"]);
});

test("stop when idle that runs out of time leaves the gateway running unchanged, also after the request ends later", async (t) => {
  const g = await startGateway(t);
  const token = g.token();
  const held = call(g.port, { target: "/v1/models?how=hold&id=a" });
  await g.backend.held("a");
  const second = call(g.port, { target: "/v1/models?how=hold&id=b" });
  await g.backend.held("b");

  assert.deepEqual(await g.gateway.stop({ whenIdle: true, waitMs: 80 }), { stopped: false, inFlight: 2 });
  // No time at all: the answer says what is in flight right now.
  assert.deepEqual(await g.gateway.stop({ whenIdle: true, waitMs: 0 }), { stopped: false, inFlight: 2 });

  assert.equal(g.token(), token);
  assert.deepEqual(JSON.parse((await get(g.port, "/v1/models?how=ok&id=new")).text), { served: "new" });
  (await g.backend.held("a")).finish("whole");
  (await g.backend.held("b")).finish("whole");
  assert.equal((await held.done).text, "whole");
  assert.equal((await second.done).text, "whole");
  await idle(g);

  // The wait is over: a later idle moment stops nothing.
  await pause(80);
  assert.equal((await liveStatus(g.port)).inFlight, 0);
  assert.equal((await get(g.port, "/v1/models?how=ok")).status, 200);
  assert.equal(g.token(), token);
  assert.deepEqual(g.events, ["backend started"]);
});

test("a stop when idle that is called off stops nothing, whether the gateway is idle or busy", async (t) => {
  const g = await startGateway(t);
  // Called off before it began, on an idle gateway.
  assert.deepEqual(await g.gateway.stop({ whenIdle: true, waitMs: 60000, signal: AbortSignal.abort() }), { stopped: false, inFlight: 0 });
  assert.equal((await get(g.port, "/v1/models?how=ok")).status, 200);

  // Called off while it waits.
  const held = call(g.port, { target: "/v1/models?how=hold&id=a" });
  await g.backend.held("a");
  const calledOff = new AbortController();
  const waiting = g.gateway.stop({ whenIdle: true, waitMs: 60000, signal: calledOff.signal });
  await pause(30);
  calledOff.abort();
  assert.deepEqual(await waiting, { stopped: false, inFlight: 1 });
  (await g.backend.held("a")).finish("whole");
  assert.equal((await held.done).text, "whole");
  await idle(g);
  await pause(60);
  assert.equal((await get(g.port, "/v1/models?how=ok")).status, 200);
  assert.deepEqual(g.events, ["backend started"]);
  assert.equal(fs.existsSync(g.tokenFile), true);
});

test("stop when idle is triggered by a request that ends because its client gave up", async (t) => {
  const g = await startGateway(t);
  const held = call(g.port, { target: "/v1/models?how=hold&id=a" });
  await g.backend.held("a");
  const stopping = g.gateway.stop({ whenIdle: true, waitMs: 60000 });
  held.destroy();
  assert.deepEqual(await stopping, { stopped: true });
  await refused(g.port);
});

test("two stop-when-idle calls at once stop the gateway once and both resolve", async (t) => {
  const g = await startGateway(t);
  const held = call(g.port, { target: "/v1/models?how=hold&id=a" });
  await g.backend.held("a");
  const first = g.gateway.stop({ whenIdle: true, waitMs: 60000 });
  const second = g.gateway.stop({ whenIdle: true, waitMs: 60000 });
  // A third gives up early and must not take the others with it.
  assert.deepEqual(await g.gateway.stop({ whenIdle: true, waitMs: 40 }), { stopped: false, inFlight: 1 });
  (await g.backend.held("a")).finish();
  await held.done;
  assert.deepEqual(await Promise.all([first, second]), [{ stopped: true }, { stopped: true }]);
  assert.deepEqual(g.events.filter((event) => event === "backend stopping"), ["backend stopping"]);
  // Asked again once it has stopped: still one stop, and an answer at once.
  assert.deepEqual(await g.gateway.stop({ whenIdle: true, waitMs: 60000 }), { stopped: true });
  await g.gateway.stop();
  assert.deepEqual(g.events, ["backend started", "backend stopping", "backend exited"]);
  assert.equal(g.logs.filter((line) => /stopping at a moment with no request in flight/.test(line)).length, 1);
});

test("a plain stop still stops at once, cutting what is in flight, and a waiting stop-when-idle then resolves", async (t) => {
  const g = await startGateway(t);
  const held = call(g.port, { target: "/v1/models?how=stream&id=a" });
  await held.firstPart;
  const waiting = g.gateway.stop({ whenIdle: true, waitMs: 60000 });
  await g.gateway.stop();
  await assert.rejects(held.done);
  assert.deepEqual(await waiting, { stopped: true });
  await refused(g.port);
  assert.equal(fs.existsSync(g.tokenFile), false);
  assert.deepEqual(g.events, ["backend started", "backend stopping", "backend exited"]);
});

test("a request whose body is still arriving is in flight: the stop waits for it and it is served whole", async (t) => {
  const g = await startGateway(t);
  const held = call(g.port, { target: "/v1/models?how=hold&id=a" });
  await g.backend.held("a");

  // Its head has arrived, its body has not: the gateway has not begun to forward it.
  const body = JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "late" }] });
  const late = http.request({ host: "127.0.0.1", port: g.port, method: "POST", path: "/v1/messages?how=ok&id=late", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } });
  const answered = new Promise((resolve, reject) => {
    late.on("error", reject);
    late.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
  });
  answered.catch(() => {});
  late.write(body.slice(0, 12));
  await flying(g, 2);

  let result = null;
  const stopping = g.gateway.stop({ whenIdle: true, waitMs: 60000 }).then((value) => { result = value; return value; });
  (await g.backend.held("a")).finish("whole");
  assert.equal((await held.done).text, "whole");
  await flying(g, 1);
  await pause(60);
  assert.equal(result, null);
  assert.deepEqual(g.events, ["backend started"]);
  assert.equal(g.backend.seen.some((request) => request.id === "late"), false);

  late.end(body.slice(12));
  assert.deepEqual(await answered, { status: 200, text: '{"served":"late"}' });
  assert.deepEqual(await stopping, { stopped: true });
  assert.equal(JSON.parse(g.backend.seen.find((request) => request.id === "late").body).messages[0].content, "late");
});

test("the port is closed in the very tick the gateway turns idle: a connection attempted at that moment is refused, not accepted and then cut", async (t) => {
  let probe = null;
  let countAtStop = null;
  const g = await startGateway(t, { onBackendStop: () => {
    countAtStop = g.gateway.inFlight();
    probe = call(g.port, { target: "/v1/models?how=ok&id=probe" });
  } });
  const held = call(g.port, { target: "/v1/models?how=stream&id=a" });
  await held.firstPart;
  const stopping = g.gateway.stop({ whenIdle: true, waitMs: 60000 });
  // Looked at once per turn of the event loop: idle and not yet stopping must
  // never be seen, or a request could be taken in between and then cut.
  let idleButOpen = 0;
  let turns = 0;
  const watch = () => {
    if (probe) return;
    turns += 1;
    if (g.gateway.inFlight() === 0) idleButOpen += 1;
    setImmediate(watch);
  };
  setImmediate(watch);
  // Up to that moment a new request is served whole.
  assert.deepEqual(JSON.parse((await get(g.port, "/v1/models?how=ok&id=during")).text), { served: "during" });
  assert.equal(probe, null);
  (await g.backend.held("a")).finish("last");
  assert.equal((await held.done).text, "first last");
  assert.deepEqual(await stopping, { stopped: true });
  assert.equal(countAtStop, 0);
  assert.ok(turns > 3);
  assert.equal(idleButOpen, 0);
  await assert.rejects(probe.done, /ECONNREFUSED/);
  assert.equal(probe.state.status, null);
  assert.equal(g.backend.seen.some((request) => request.id === "probe"), false);
});

for (const seed of [11, 12, 13]) {
  test(`requests arriving around the moment the gateway turns idle are served whole or fail before the gateway took them (seed ${seed})`, async (t) => {
    let portClosed = false;
    const g = await startGateway(t, { onBackendStop: () => { portClosed = true; } });
    const random = generator(seed);
    // Some arrive on connections that were opened earlier and kept.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 3 });
    t.after(() => agent.destroy());
    await Promise.all([0, 1, 2].map((index) => call(g.port, { target: `/v1/models?how=ok&id=warm${index}`, agent }).done));
    const held = call(g.port, { target: "/v1/models?how=hold&id=a" });
    const a = await g.backend.held("a");

    const stopping = g.gateway.stop({ whenIdle: true, waitMs: 60000 });
    const racers = [];
    const fire = () => {
      const id = `race${racers.length}`;
      const request = call(g.port, { target: `/v1/models?how=ok&id=${id}`, agent: random() < 0.4 ? agent : false });
      racers.push({ id, request, outcome: request.done.then(() => "served", (error) => error.code || error.message) });
    };
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    // While the stop waits, requests are served.
    for (let index = 0; index < 3; index += 1) fire();
    assert.deepEqual(await Promise.all(racers.map((racer) => racer.outcome)), ["served", "served", "served"]);
    // From here on they keep arriving, at first so densely that something is
    // nearly always in flight, then more and more thinly. The first gap is
    // the idle moment: the requests on either side of it are the ones at risk.
    let afterStop = 0;
    for (let turns = 0; afterStop < 12; turns += 1) {
      assert.ok(turns < 50000, "the gateway never became idle");
      if (turns === 5) a.finish("whole");
      if (random() < Math.max(0.05, 0.6 - turns / 1500)) fire();
      if (portClosed) afterStop += 1;
      await turn();
    }
    // And once it has stopped, they are refused.
    assert.deepEqual(await stopping, { stopped: true });
    fire();

    assert.equal((await held.done).text, "whole");
    assert.deepEqual(await stopping, { stopped: true });
    const outcomes = await Promise.all(racers.map((racer) => racer.outcome));
    const served = new Set();
    racers.forEach((racer, index) => {
      if (outcomes[index] === "served") {
        assert.deepEqual([racer.request.state.status, racer.request.state.text], [200, JSON.stringify({ served: racer.id })], racer.id);
        served.add(racer.id);
        return;
      }
      // Not served: refused at connect, or its connection was closed before
      // the gateway read anything from it. No part of an answer was sent.
      assert.ok(["ECONNREFUSED", "ECONNRESET"].includes(outcomes[index]), `${racer.id}: ${outcomes[index]}`);
      assert.equal(racer.request.state.status, null, racer.id);
    });
    // Whatever the gateway passed on to the backend was answered in full.
    for (const request of g.backend.seen.filter((item) => item.id.startsWith("race"))) assert.ok(served.has(request.id), `${request.id} was taken and then cut`);
    assert.equal(outcomes.at(-1), "ECONNREFUSED");
    t.diagnostic(`${racers.length} requests: ${served.size} served whole, ${outcomes.filter((outcome) => outcome === "ECONNREFUSED").length} refused at connect, ${outcomes.filter((outcome) => outcome === "ECONNRESET").length} closed before the gateway read them`);
    assert.equal(g.gateway.inFlight(), 0);
    assert.deepEqual(g.events, ["backend started", "backend stopping", "backend exited"]);
  });
}

// ------------------------------- the control call -------------------------------
test("the control call stops an idle gateway, answers once the backend has exited, and the process is then told to exit", async (t) => {
  const g = await startGateway(t, { backendExitMs: 120 });
  // A connection another client keeps open is closed by the stop.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  await call(g.port, { target: "/v1/models?how=ok", agent }).done;

  // The caller keeps the connection of its call open as well.
  const asked = call(g.port, { method: "POST", target: "/dshproxy/control/stop", headers: { "x-dshproxy-token": g.token(), "content-type": "application/json" }, body: JSON.stringify({ waitSeconds: 5 }), agent });
  const answer = await asked.done;
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.text), { stopped: true });
  assert.equal(answer.text, '{"stopped":true}');
  // By the time the answer is there, the port is closed and the backend gone.
  assert.deepEqual(g.events.slice(0, 3), ["backend started", "backend stopping", "backend exited"]);
  await refused(g.port);
  assert.equal(fs.existsSync(g.tokenFile), false);
  // The process is not ended under a caller that still holds the connection
  // its answer came on: only once the caller has hung up.
  await pause(300);
  assert.deepEqual(g.events, ["backend started", "backend stopping", "backend exited"]);
  agent.destroy();
  await until(() => g.events.includes("exit"), "the exit", 1500);
  await pause(30);
  assert.deepEqual(g.events, ["backend started", "backend stopping", "backend exited", "exit"]);
  assert.ok(g.logs.some((line) => /stopping at a moment with no request in flight/.test(line)));
  assert.equal(g.logs.some((line) => /did not close its connection/.test(line)), false);
});

test("a caller that never hangs up is cut off about two seconds after the answer, and the process is then told to exit", async (t) => {
  // First a gateway whose caller hangs up as it should: nothing is cut off there, now or later.
  const orderly = await startGateway(t);
  assert.equal((await control(orderly, "stop", { waitSeconds: 5 }).done).text, '{"stopped":true}');
  await until(() => orderly.events.includes("exit"), "the exit of the first gateway", 1500);

  const g = await startGateway(t);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  let closedByGateway = false;
  agent.on("free", (socket) => socket.once("close", () => { closedByGateway = true; }));
  const answer = await call(g.port, { method: "POST", target: "/dshproxy/control/stop", headers: { "x-dshproxy-token": g.token(), "content-type": "application/json" }, body: JSON.stringify({ waitSeconds: 5 }), agent }).done;
  const answered = Date.now();
  assert.equal(answer.text, '{"stopped":true}');
  // Well before the five seconds after which an unused connection is closed anyway.
  await until(() => g.events.includes("exit"), "the exit", 4000);
  assert.ok(Date.now() - answered >= 1500, `told to exit ${Date.now() - answered} ms after the answer`);
  await until(() => closedByGateway, "the gateway to close the connection");
  assert.deepEqual(g.events, ["backend started", "backend stopping", "backend exited", "exit"]);
  assert.equal(g.logs.filter((line) => /stop when idle: the caller did not close its connection within 2 s of the answer/.test(line)).length, 1);
  // The first gateway stopped more than two seconds ago by now.
  assert.equal(orderly.logs.some((line) => /did not close its connection/.test(line)), false);
});

test("the gateway does not hang up first after its answer, also when the caller asked for the connection to be closed", async (t) => {
  const g = await startGateway(t);
  const body = JSON.stringify({ waitSeconds: 5 });
  const socket = net.connect(g.port, "127.0.0.1");
  t.after(() => socket.destroy());
  let text = "";
  let hungUp = false;
  socket.on("data", (chunk) => { text += chunk; });
  socket.on("end", () => { hungUp = true; });
  socket.on("error", () => { hungUp = true; });
  socket.write(`POST /dshproxy/control/stop HTTP/1.1\r\nHost: 127.0.0.1:${g.port}\r\nConnection: close\r\nx-dshproxy-token: ${g.token()}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
  await until(() => text.endsWith('{"stopped":true}'), "the answer");
  // The answer is whole without the connection being closed: its length is given.
  assert.match(text, /\r\ncontent-length: 16\r\n/i);
  await pause(300);
  assert.equal(hungUp, false);
  assert.deepEqual(g.events, ["backend started", "backend stopping", "backend exited"]);
  socket.end();
  await until(() => g.events.includes("exit"), "the exit", 1500);
  assert.equal(g.logs.some((line) => /did not close its connection/.test(line)), false);
});

test("the control call waits for a request in flight, and its default wait is 300 seconds", async (t) => {
  const g = await startGateway(t);
  const held = call(g.port, { target: "/v1/models?how=stream&id=a" });
  await held.firstPart;
  const asked = control(g, "stop", {});
  await until(() => g.logs.some((line) => /stop when idle requested: waiting up to 300 s \(1 in flight\)/.test(line)), "the stop call to be waiting");
  // Seconds, not a shorter unit: it is still waiting well after 300 ms.
  await pause(450);
  assert.equal(asked.state.status, null);
  assert.equal((await get(g.port, "/v1/models?how=ok")).status, 200);
  (await g.backend.held("a")).finish("last");
  assert.equal((await held.done).text, "first last");
  assert.deepEqual(JSON.parse((await asked.done).text), { stopped: true });
  await until(() => g.events.includes("exit"), "the exit");
});

test("two stop calls over the control interface are both answered, and the process is told to exit once", async (t) => {
  const g = await startGateway(t);
  const held = call(g.port, { target: "/v1/models?how=hold&id=a" });
  await g.backend.held("a");
  const first = control(g, "stop", { waitSeconds: 30 });
  const second = control(g, "stop", { waitSeconds: 30 });
  await until(() => g.logs.filter((line) => /stop when idle requested/.test(line)).length === 2, "both stop calls to be waiting");
  (await g.backend.held("a")).finish("whole");
  assert.equal((await held.done).text, "whole");
  const answers = await Promise.all([first.done, second.done]);
  assert.deepEqual(answers.map((answer) => [answer.status, answer.text]), [[200, '{"stopped":true}'], [200, '{"stopped":true}']]);
  await until(() => g.events.includes("exit"), "the exit");
  await pause(40);
  assert.deepEqual(g.events, ["backend started", "backend stopping", "backend exited", "exit"]);
  assert.equal(g.logs.filter((line) => /stopping at a moment with no request in flight/.test(line)).length, 1);
});

test("a caller that goes away while the backend is still exiting does not keep the process from being told to exit", async (t) => {
  let gone = null;
  // The second caller drops its connection in the tick the gateway stops:
  // too late to call the stop off, and before there is an answer to send.
  const g = await startGateway(t, { backendExitMs: 300, onBackendStop: () => gone.destroy() });
  const held = call(g.port, { target: "/v1/models?how=hold&id=a" });
  await g.backend.held("a");
  const stays = control(g, "stop", { waitSeconds: 30 });
  gone = control(g, "stop", { waitSeconds: 30 });
  await until(() => g.logs.filter((line) => /stop when idle requested/.test(line)).length === 2, "both stop calls to be waiting");
  (await g.backend.held("a")).finish("whole");
  assert.equal((await held.done).text, "whole");
  assert.equal((await stays.done).text, '{"stopped":true}');
  await assert.rejects(gone.done);
  await until(() => g.events.includes("exit"), "the exit", 1500);
  await pause(40);
  assert.deepEqual(g.events, ["backend started", "backend stopping", "backend exited", "exit"]);
  assert.equal(g.logs.some((line) => /did not close its connection/.test(line)), false);
});

test("the control call that runs out of time says what is in flight and leaves the gateway running", async (t) => {  const g = await startGateway(t);
  const held = call(g.port, { target: "/v1/models?how=hold&id=a" });
  await g.backend.held("a");
  for (const waitSeconds of [0, 1]) {
    const answer = await control(g, "stop", { waitSeconds }).done;
    assert.equal(answer.status, 200);
    assert.equal(answer.text, '{"stopped":false,"inFlight":1}');
  }
  assert.ok(g.logs.some((line) => /still 1 in flight after 1 s; the gateway keeps running/.test(line)));
  (await g.backend.held("a")).finish("whole");
  assert.equal((await held.done).text, "whole");
  await idle(g);
  await pause(60);
  assert.equal((await get(g.port, "/v1/models?how=ok")).status, 200);
  assert.deepEqual(g.events, ["backend started"]);
});

test("the control call is refused without the token, from a web page, or with a wait that is not a whole number of seconds, and nothing stops", async (t) => {
  const g = await startGateway(t);
  assert.equal((await control(g, "stop", { waitSeconds: 0 }, { token: "" }).done).status, 401);
  assert.equal((await control(g, "stop", { waitSeconds: 0 }, { token: "c".repeat(64) }).done).status, 401);
  assert.equal((await control(g, "stop", { waitSeconds: 0 }, { headers: { origin: "https://evil.example" } }).done).status, 403);
  assert.equal((await call(g.port, { target: "/dshproxy/control/stop", headers: { "x-dshproxy-token": g.token() } }).done).status, 404);
  for (const waitSeconds of [-1, 1.5, "5", null, 86401, [5], { seconds: 5 }, true]) {
    const answer = await control(g, "stop", { waitSeconds }).done;
    assert.equal(answer.status, 400, JSON.stringify(waitSeconds));
    assert.match(JSON.parse(answer.text).error, /waitSeconds/);
  }
  await pause(40);
  assert.equal((await get(g.port, "/v1/models?how=ok")).status, 200);
  assert.deepEqual(g.events, ["backend started"]);
  assert.equal(fs.existsSync(g.tokenFile), true);
});

test("when the caller of the control call goes away, the wait is dropped and the gateway keeps running", async (t) => {
  const g = await startGateway(t);
  const held = call(g.port, { target: "/v1/models?how=hold&id=a" });
  await g.backend.held("a");
  const asked = control(g, "stop", { waitSeconds: 30 });
  await until(() => g.logs.some((line) => /stop when idle requested/.test(line)), "the stop call to be waiting");
  asked.destroy();
  await until(() => g.logs.some((line) => /caller went away; the gateway keeps running/.test(line)), "the wait to be dropped");
  (await g.backend.held("a")).finish("whole");
  assert.equal((await held.done).text, "whole");
  await idle(g);
  await pause(80);
  assert.equal((await get(g.port, "/v1/models?how=ok")).status, 200);
  assert.deepEqual(g.events, ["backend started"]);
});

test("the control token is in no log line and no status", async (t) => {
  const g = await startGateway(t);
  const token = g.token();
  assert.match(token, /^[0-9a-f]{64}$/);
  const status = await get(g.port, "/dshproxy/status");
  await control(g, "stop", { waitSeconds: 0 }).done;
  assert.equal(status.text.includes(token), false);
  assert.equal(g.logs.join("\n").includes(token), false);
  assert.equal(fs.readFileSync(path.join(g.home, "dshproxy.log"), "utf8").includes(token), false);
});

// ------------------------------- restart after an update or rollback -------------------------------

test("a restart stops an idle gateway at once and says nothing about waiting", async (t) => {
  const g = await startGateway(t);
  assert.deepEqual(await stopForRestart(g.gateway, { limitMs: 600, noteMs: 200 }), { cut: 0 });
  await refused(g.port);
  assert.deepEqual(g.logs.filter((line) => /Restart|cut/.test(line)), []);
  assert.deepEqual(g.events, ["backend started", "backend stopping", "backend exited"]);
});

test("a restart waits for the request in flight, logs while it waits, and cuts nothing", async (t) => {
  const g = await startGateway(t);
  const held = call(g.port, { target: "/v1/models?how=stream&id=a" });
  await held.firstPart;
  const restarting = stopForRestart(g.gateway, { limitMs: 60000, noteMs: 50 });
  const waiting = (line) => /Restart is waiting for 1 request in flight/.test(line);
  await until(() => g.logs.filter(waiting).length >= 2, "two waiting lines");
  assert.deepEqual(g.events, ["backend started"]);
  assert.equal((await get(g.port, "/v1/models?how=ok")).status, 200);
  (await g.backend.held("a")).finish("last");
  assert.equal((await held.done).text, "first last");
  assert.deepEqual(await restarting, { cut: 0 });
  await refused(g.port);
  assert.match(g.logs.find((line) => /Restart requested/.test(line)), /1 request in flight/);
  assert.deepEqual(g.logs.filter((line) => /cut/.test(line)), []);
  // The lines are in the log file, not only on the console.
  assert.match(fs.readFileSync(path.join(g.home, "dshproxy.log"), "utf8"), /Restart is waiting for 1 request in flight/);
});

test("a restart that has waited its limit restarts anyway and logs how many requests were cut", async (t) => {
  const g = await startGateway(t);
  const first = call(g.port, { target: "/v1/models?how=stream&id=a" });
  const second = call(g.port, { target: "/v1/models?how=hold&id=b" });
  await first.firstPart;
  await g.backend.held("b");
  // The limit is three notes long: a line after the first and the second, then the cut.
  assert.deepEqual(await stopForRestart(g.gateway, { limitMs: 150, noteMs: 50 }), { cut: 2 });
  await assert.rejects(first.done);
  await assert.rejects(second.done);
  await refused(g.port);
  assert.equal(g.logs.filter((line) => /Restart is waiting for 2 requests in flight/.test(line)).length, 2);
  const cut = g.logs.filter((line) => /cut/.test(line));
  assert.equal(cut.length, 1);
  assert.match(cut[0], /2 requests in flight were cut/);
  assert.match(fs.readFileSync(path.join(g.home, "dshproxy.log"), "utf8"), /2 requests in flight were cut/);
});

test("by default a restart asks once a minute and gives up waiting after 15 minutes", async () => {
  // A gateway that never becomes idle and answers each wait at once, so the
  // fifteen minutes pass without waiting for them.
  const waits = [];
  const lines = [];
  let plainStops = 0;
  const busy = {
    inFlight: () => 3,
    log: (line) => lines.push(line),
    stop: async (options) => {
      if (!options) { plainStops += 1; return []; }
      waits.push(options);
      return { stopped: false, inFlight: 3 };
    }
  };
  assert.deepEqual(await stopForRestart(busy), { cut: 3 });
  assert.deepEqual(waits, Array.from({ length: 15 }, () => ({ whenIdle: true, waitMs: 60000 })));
  assert.equal(plainStops, 1);
  const waiting = lines.filter((line) => /Restart is waiting/.test(line));
  assert.equal(waiting.length, 14);
  assert.match(waiting[0], /1 min so far, at most 15 min/);
  assert.match(waiting[13], /14 min so far, at most 15 min/);
  assert.match(lines.at(-1), /after waiting 15 min: 3 requests in flight were cut/);
});

test("a restart that finds the gateway idle at the very end of its limit reports nothing cut", async () => {
  const lines = [];
  let count = 1;
  const gateway = {
    inFlight: () => count,
    log: (line) => lines.push(line),
    stop: async (options) => {
      if (!options) return [];
      count = 0;
      return { stopped: false, inFlight: 1 };
    }
  };
  assert.deepEqual(await stopForRestart(gateway, { limitMs: 10, noteMs: 10 }), { cut: 0 });
  assert.deepEqual(lines.filter((line) => /were cut|was cut/.test(line)), []);
});

// ------------------------------- the command -------------------------------

// Runs the real CLI in its own process. It is refused unless its data folder
// is a throwaway one whose settings name spare ports, so that it can never
// address the gateway that serves this machine.
function cli(home, args) {
  assert.ok(home.startsWith(sandbox));
  const settings = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
  for (const port of [settings.port, settings.backendPort]) assert.ok(ports.has(port) && !LIVE_PORTS.includes(port));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, DSHPROXY_HOME: home, DSH_HOME: path.join(home, "no-deepseek-harness") }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

// A program on the gateway's port that answers its status and records what the
// command sends to the control interface. `answer(req, res, body)` replies.
// `status.error`, when set, says what becomes of a status request: "hold"
// keeps it unanswered until `answerStatus()`, "drop" cuts its connection, and
// any other true value answers 500.
async function fakeGateway(t, { status = { startedAt: "2026-11-22T00:00:00.000Z", backend: { name: "CLIProxyAPI", version: "0.0.0", running: true, pid: 4242 }, lanes: [] }, answer, token = "d".repeat(64) } = {}) {
  const home = fs.mkdtempSync(path.join(sandbox, "home-"));
  const calls = [];
  const heldStatus = [];
  const sendStatus = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(status));
  };
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/dshproxy/status") {
      const failing = typeof status.error === "function" && status.error();
      if (failing === "drop") return void req.socket.destroy();
      if (failing === "hold") return void heldStatus.push(res);
      res.writeHead(failing ? 500 : 200, { "content-type": "application/json" });
      res.end(failing ? "{}" : JSON.stringify(status));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ method: req.method, url: req.url, token: req.headers["x-dshproxy-token"], origin: req.headers.origin, type: req.headers["content-type"], body });
      answer(req, res, body, { server, tokenFile: path.join(home, "control.token") });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  assert.ok(!LIVE_PORTS.includes(port));
  ports.add(port);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ port, backendPort: await sparePort() }));
  if (token !== null) fs.writeFileSync(path.join(home, "control.token"), `${token}\n`);
  return { home, port, calls, token, status, heldStatus, answerStatus: () => heldStatus.splice(0).forEach(sendStatus) };
}
const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const USAGE = /Usage: dshproxy stop --when-idle \[--wait SECONDS\]/;

test("dshproxy stop without --when-idle, or with anything it does not know, is a usage error and asks the gateway nothing", async (t) => {
  const g = await fakeGateway(t, { answer: (_req, res) => json(res, 200, { stopped: true }) });
  for (const args of [["stop"], ["stop", "--now"], ["stop", "now"], ["stop", "--wait", "5"], ["stop", "--when-idle", "--wait"], ["stop", "--when-idle", "--wait", "soon"], ["stop", "--when-idle", "--wait", "-1"],
    ["stop", "--when-idle", "--wait", "1.5"], ["stop", "--when-idle", "--wait", "86401"], ["stop", "--when-idle", "5"], ["stop", "--when-idle", "--wait", "5", "extra"], ["stop", "--when-idle", "--when-idle"], ["stop", "--when-idle", "--force"], ["stop", "--when-idle", "--wait", "5", "--wait", "6"]]) {
    const run = await cli(g.home, args);
    assert.equal(run.status, 1, args.join(" "));
    assert.equal(run.stdout, "", args.join(" "));
    assert.match(run.stderr, USAGE, args.join(" "));
  }
  assert.deepEqual(g.calls, []);
});

test("dshproxy stop --when-idle asks the running gateway over the control interface, with the token from its file and a default wait of 300 seconds", async (t) => {
  const g = await fakeGateway(t, { answer: (_req, res) => json(res, 200, { stopped: true }) });
  const run = await cli(g.home, ["stop", "--when-idle"]);
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, '{"stopped":true}\n', ""]);
  await cli(g.home, ["stop", "--when-idle", "--wait", "7"]);
  await cli(g.home, ["stop", "--wait", "0", "--when-idle"]);
  assert.deepEqual(g.calls.map((item) => [item.method, item.url, item.token, item.origin, item.type, JSON.parse(item.body)]), [
    ["POST", "/dshproxy/control/stop", g.token, undefined, "application/json", { waitSeconds: 300 }],
    ["POST", "/dshproxy/control/stop", g.token, undefined, "application/json", { waitSeconds: 7 }],
    ["POST", "/dshproxy/control/stop", g.token, undefined, "application/json", { waitSeconds: 0 }]
  ]);
});

test("dshproxy stop --when-idle prints what is in flight and exits 2 when the gateway did not stop", async (t) => {
  const g = await fakeGateway(t, { answer: (_req, res) => json(res, 200, { stopped: false, inFlight: 4 }) });
  const run = await cli(g.home, ["stop", "--when-idle", "--wait", "1"]);
  assert.deepEqual([run.status, run.stdout, run.stderr], [2, '{"stopped":false,"inFlight":4}\n', ""]);
});

test("dshproxy stop --when-idle without a running gateway says so and exits 1", async (t) => {
  const home = fs.mkdtempSync(path.join(sandbox, "home-"));
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ port: await sparePort(), backendPort: await sparePort() }));
  // A token left behind by a gateway that was killed changes nothing.
  for (const leftover of [false, true]) {
    if (leftover) fs.writeFileSync(path.join(home, "control.token"), `${"e".repeat(64)}\n`);
    const run = await cli(home, ["stop", "--when-idle", "--wait", "1"]);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /^DSHProxy: The gateway is not running/);
    assert.equal(run.stderr.includes("e".repeat(64)), false);
  }
});

// A gateway that is busy can take longer over its status than the command
// waits for it. That is not a gateway that is not running.
test("dshproxy stop --when-idle asks a gateway to stop all the same when its status comes late or cannot be read, and does not call it not running", async (t) => {
  // The status is answered only when the stop call has arrived: late.
  const slow = await fakeGateway(t, { answer: (_req, res) => { slow.answerStatus(); json(res, 200, { stopped: true }); } });
  slow.status.error = () => "hold";
  // The status is an answer the command cannot read.
  const odd = await fakeGateway(t, { answer: (_req, res) => json(res, 200, { stopped: false, inFlight: 2 }) });
  odd.status.error = () => true;
  const [late, unreadable] = await Promise.all([cli(slow.home, ["stop", "--when-idle", "--wait", "1"]), cli(odd.home, ["stop", "--when-idle", "--wait", "1"])]);
  assert.deepEqual([late.status, late.stdout, late.stderr], [0, '{"stopped":true}\n', ""]);
  assert.deepEqual(slow.calls.map((call) => [call.method, call.url, call.token, call.body]), [["POST", "/dshproxy/control/stop", slow.token, '{"waitSeconds":1}']]);
  assert.deepEqual([unreadable.status, unreadable.stdout, unreadable.stderr], [2, '{"stopped":false,"inFlight":2}\n', ""]);
  assert.equal(odd.calls.length, 1);
});

test("dshproxy stop --when-idle refuses, without calling the gateway not running, when its status comes late and there is no control token to ask it with", async (t) => {
  for (const token of [null, "not a token"]) {
    const g = await fakeGateway(t, { token, answer: (_req, res) => json(res, 200, { stopped: true }) });
    g.status.error = () => "hold";
    const started = Date.now();
    const run = await cli(g.home, ["stop", "--when-idle", "--wait", "1"]);
    const elapsed = Date.now() - started;
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, `DSHProxy: The gateway on http://127.0.0.1:${g.port} did not give its status within 2 seconds; it may be busy. ${path.join(g.home, "control.token")} cannot be read, so it cannot be asked to stop. Nothing was stopped.\n`);
    // It waited for the status, once, and asked for nothing else.
    assert.ok(elapsed >= 2000 && elapsed < 15000, `${elapsed} ms`);
    assert.equal(g.heldStatus.length, 1);
    assert.deepEqual(g.calls, []);
  }
});

test("dshproxy stop --when-idle exits 1 with a reason, and never shows the token, when the gateway cannot be asked or answers something else", async (t) => {
  const cases = [
    ["an older gateway without the call", { answer: (_req, res) => json(res, 404, { error: "No such control call." }) }, /older DSHProxy/],
    ["a gateway that does not accept the token", { answer: (_req, res) => json(res, 401, { error: "Missing or wrong control token." }) }, /did not accept the control token/],
    ["a gateway that drops the connection and goes on running", { answer: (req) => req.socket.destroy() }, /^DSHProxy: The connection to the gateway was lost before it answered, and it is still running on http:\/\/127\.0\.0\.1:\d+\. Nothing was stopped\.\n$/],
    ["an answer that is not the documented one", { answer: (_req, res) => json(res, 200, { stopped: "yes" }) }, /did not understand/],
    ["an answer without a count", { answer: (_req, res) => json(res, 200, { stopped: false }) }, /did not understand/],
    ["an answer that is not JSON", { answer: (_req, res) => { res.writeHead(200); res.end("stopped"); } }, /did not understand/],
    ["a refusal that repeats the token", { answer: (req, res) => json(res, 400, { error: `bad call from ${req.headers["x-dshproxy-token"]}` }) }, /HTTP 400/],
    ["no token file", { token: null, answer: (_req, res) => json(res, 200, { stopped: true }) }, /^DSHProxy: \S+control\.token cannot be read, so the running gateway cannot be asked\. Nothing was stopped\.\n$/]
  ];
  for (const [name, options, reason] of cases) {
    const g = await fakeGateway(t, options);
    const run = await cli(g.home, ["stop", "--when-idle", "--wait", "1"]);
    assert.equal(run.status, 1, name);
    assert.equal(run.stdout, "", name);
    assert.match(run.stderr, reason, name);
    assert.match(run.stderr, /^DSHProxy: /, name);
    if (g.token) assert.equal(`${run.stdout}${run.stderr}`.includes(g.token), false, name);
    if (options.token === null) assert.deepEqual(g.calls, [], name);
  }
  // A token file that does not hold a token is not sent anywhere.
  const g = await fakeGateway(t, { token: "not a token\r\nx-injected: 1", answer: (_req, res) => json(res, 200, { stopped: true }) });
  const run = await cli(g.home, ["stop", "--when-idle"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^DSHProxy: \S+control\.token cannot be read, so the running gateway cannot be asked\. Nothing was stopped\.\n$/);
  assert.equal(run.stderr.includes("not a token"), false);
  assert.deepEqual(g.calls, []);
});

// The connection that carries the answer can be lost although the gateway did
// what it was asked: the command then looks at what became of the gateway.
const dropAndClose = (after = () => {}) => (req, _res, _body, gateway) => {
  gateway.server.close();
  gateway.server.closeAllConnections();
  req.socket.destroy();
  after(gateway);
};

test("dshproxy stop --when-idle whose answer is lost finds the gateway stopped: its port is closed and its control token is gone", async (t) => {
  const g = await fakeGateway(t, { answer: dropAndClose((gateway) => fs.rmSync(gateway.tokenFile)) });
  const run = await cli(g.home, ["stop", "--when-idle", "--wait", "1"]);
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, '{"stopped":true}\n', ""]);
  assert.equal(g.calls.length, 1);

  // A gateway caught in the middle of stopping: the token goes a moment later.
  const slower = await fakeGateway(t, { answer: dropAndClose((gateway) => setTimeout(() => fs.rmSync(gateway.tokenFile), 700)) });
  const later = await cli(slower.home, ["stop", "--when-idle", "--wait", "1"]);
  assert.deepEqual([later.status, later.stdout, later.stderr], [0, '{"stopped":true}\n', ""]);
});

test("dshproxy stop --when-idle whose answer is lost says that it is not known whether the gateway stopped, after a few seconds at most, when that cannot be established", async (t) => {
  const unknown = /^DSHProxy: The gateway's answer did not arrive: the connection was lost, and it is not known whether the gateway stopped\. Check with `dshproxy status`\.\n$/;
  // Its port is closed, but its token is still there: it may have been killed.
  const closed = await fakeGateway(t, { answer: dropAndClose() });
  // Something answers on its port, but not with a gateway's status.
  let dropped = false;
  const other = await fakeGateway(t, { answer: (req) => { dropped = true; req.socket.destroy(); } });
  other.status.error = () => dropped;
  // Its token is gone, and its port takes connections and drops them: a port
  // that is still open is not a stopped gateway.
  let droppedToo = false;
  const tokenless = await fakeGateway(t, { answer: (req, _res, _body, gateway) => { droppedToo = true; fs.rmSync(gateway.tokenFile); req.socket.destroy(); } });
  tokenless.status.error = () => droppedToo && "drop";
  const started = Date.now();
  const runs = await Promise.all([closed, other, tokenless].map((g) => cli(g.home, ["stop", "--when-idle", "--wait", "1"])));
  const elapsed = Date.now() - started;
  for (const [index, run] of runs.entries()) {
    assert.equal(run.status, 1, String(index));
    assert.equal(run.stdout, "", String(index));
    assert.match(run.stderr, unknown, String(index));
  }
  // It looked for a while, and not for long.
  assert.ok(elapsed >= 2500 && elapsed < 15000, `${elapsed} ms`);
  for (const g of [closed, other, tokenless]) assert.equal(runs.map((run) => run.stderr).join("").includes(g.token), false);
});

test("dshproxy stop --when-idle hangs up by itself once it has read the answer, and ends, when the gateway keeps the connection open", async (t) => {
  let hungUp = false;
  // This gateway never closes the connection, as a stopped gateway does not: only the command can.
  const g = await fakeGateway(t, { answer: (req, res, _body, gateway) => {
    gateway.server.keepAliveTimeout = 0;
    req.socket.once("close", () => { hungUp = true; });
    res.setHeader("connection", "keep-alive");
    json(res, 200, { stopped: true });
  } });
  const started = Date.now();
  const run = await cli(g.home, ["stop", "--when-idle", "--wait", "1"]);
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, '{"stopped":true}\n', ""]);
  assert.ok(Date.now() - started < 20000, "the command did not end by itself");
  await until(() => hungUp, "the command to close its connection");
});

test("status --json carries the gateway's count of requests in flight, and null when there is none to ask", async (t) => {
  const g = await startGateway(t);
  const held = call(g.port, { target: "/v1/models?how=hold&id=a" });
  await g.backend.held("a");
  const busy = JSON.parse((await cli(g.home, ["status", "--json"])).stdout);
  assert.deepEqual([busy.running, busy.inFlight], [true, 1]);
  assert.match((await cli(g.home, ["status"])).stdout, /^Requests in flight: 1$/m);
  (await g.backend.held("a")).finish();
  await held.done;
  await idle(g);
  assert.equal(JSON.parse((await cli(g.home, ["status", "--json"])).stdout).inFlight, 0);

  await g.gateway.stop();
  const stopped = JSON.parse((await cli(g.home, ["status", "--json"])).stdout);
  assert.deepEqual([stopped.running, stopped.inFlight], [false, null]);
  assert.doesNotMatch((await cli(g.home, ["status"])).stdout, /Requests in flight/);

  // A gateway from before this count existed does not report one.
  const older = await fakeGateway(t, { answer: (_req, res) => json(res, 404, {}) });
  const unknown = JSON.parse((await cli(older.home, ["status", "--json"])).stdout);
  assert.deepEqual([unknown.running, unknown.inFlight], [true, null]);
});

test("the command against the real gateway: stopped when idle, not stopped while a request is held, and the token is never shown", async (t) => {
  const g = await startGateway(t);
  const token = g.token();
  const held = call(g.port, { target: "/v1/models?how=stream&id=a" });
  await held.firstPart;

  const early = await cli(g.home, ["stop", "--when-idle", "--wait", "1"]);
  assert.deepEqual([early.status, early.stdout, early.stderr], [2, '{"stopped":false,"inFlight":1}\n', ""]);
  assert.equal((await get(g.port, "/v1/models?how=ok")).status, 200);
  assert.deepEqual(g.events, ["backend started"]);

  // Without --wait the gateway is told the default.
  const waiting = cli(g.home, ["stop", "--when-idle"]);
  await until(() => g.logs.some((line) => /waiting up to 300 s \(1 in flight\)/.test(line)), "the command to be waiting");
  (await g.backend.held("a")).finish("last");
  assert.equal((await held.done).text, "first last");
  const stopped = await waiting;
  assert.deepEqual([stopped.status, stopped.stdout, stopped.stderr], [0, '{"stopped":true}\n', ""]);
  await until(() => g.events.includes("exit"), "the exit");
  assert.deepEqual(g.events, ["backend started", "backend stopping", "backend exited", "exit"]);
  await refused(g.port);
  assert.equal(`${early.stdout}${early.stderr}${stopped.stdout}${stopped.stderr}`.includes(token), false);

  const gone = await cli(g.home, ["stop", "--when-idle"]);
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /The gateway is not running/);
});

// `dshproxy start` itself, in its own process, with the backend program left
// out through the daemon's seam. Its stand-in backend answers at once, or with
// ?delay=MS sends a first part at once and the rest after that long.
async function startChildGateway(t, prepare = () => {}) {
  const home = fs.mkdtempSync(path.join(sandbox, "home-"));
  const port = await sparePort();
  const backendPort = await sparePort();
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ port, backendPort }));
  prepare(home);
  const script = `
    const path = require("path");
    const http = require("http");
    const root = ${JSON.stringify(ROOT)};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (new URL(String(url)).hostname !== "127.0.0.1") throw new Error("network is forbidden in this test");
      return realFetch(url, options);
    };
    let backend = null;
    const supervisor = {
      start: () => new Promise((resolve, reject) => {
        backend = http.createServer((req, res) => {
          req.resume();
          req.on("end", () => {
            const delay = Number(new URL(req.url, "http://backend").searchParams.get("delay") || 0);
            res.writeHead(200, { "content-type": "text/plain" });
            if (!delay) return res.end("{}");
            res.write("first ");
            setTimeout(() => res.end("last"), delay);
          });
        });
        backend.once("error", reject);
        backend.listen(${backendPort}, "127.0.0.1", resolve);
      }),
      stop: () => new Promise((resolve) => { backend.closeAllConnections(); backend.close(() => resolve()); }),
      state: () => ({ running: true, pid: 4242, restarts: 0 })
    };
    // Something else in the process is always pending, as in a real gateway:
    // it ends only if it is told to.
    setInterval(() => {}, 60000);
    const daemon = require(path.join(root, "src", "daemon.js"));
    const start = daemon.start;
    daemon.start = (options) => start({ ...options, backend: { install: async () => ({ path: "no-backend-program", installed: false }), createSupervisor: () => supervisor } });
    require(path.join(root, "src", "cli.js")).main(["start"], (line) => console.log(line)).catch((error) => { console.error(error); process.exit(3); });`;
  const child = spawn(process.execPath, ["-e", script], { env: { ...process.env, DSHPROXY_HOME: home, DSH_HOME: path.join(home, "no-deepseek-harness") }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  await until(() => /listening on/.test(output) || child.exitCode !== null, "the gateway to listen", 20000);
  assert.match(output, new RegExp(`listening on http://127\\.0\\.0\\.1:${port} `), output);
  // Resolves to how the process ended, or to "still running" after ten seconds.
  const ended = () => {
    let giveUp;
    const tooLong = new Promise((resolve) => { giveUp = setTimeout(resolve, 10000, "still running"); });
    return Promise.race([exited, tooLong]).finally(() => clearTimeout(giveUp));
  };
  return { home, port, backendPort, child, ended, output: () => output, token: () => fs.readFileSync(path.join(home, "control.token"), "utf8").trim() };
}

// What an app that started the gateway sees: the process ends by itself, with
// exit code 0, once the command has stopped it.
test("a gateway started with dshproxy start exits by itself, with code 0, once stop --when-idle has stopped it", async (t) => {
  const g = await startChildGateway(t);
  const token = g.token();

  const status = JSON.parse((await cli(g.home, ["status", "--json"])).stdout);
  assert.deepEqual([status.running, status.inFlight], [true, 0]);
  assert.equal((await get(g.port, "/v1/models")).status, 200);

  const stopped = await cli(g.home, ["stop", "--when-idle", "--wait", "10"]);
  assert.deepEqual([stopped.status, stopped.stdout, stopped.stderr], [0, '{"stopped":true}\n', ""]);
  // When the command returns, both ports are already free.
  await refused(g.port);
  await refused(g.backendPort);
  assert.deepEqual(await g.ended(), { code: 0, signal: null });
  assert.equal(fs.existsSync(path.join(g.home, "control.token")), false);
  assert.equal(g.output().includes(token), false);
  assert.match(g.output(), /stopping at a moment with no request in flight/);
});

// What went wrong on a busy machine: the gateway process ended while the
// caller had not read the answer yet, Windows reset the connection, and the
// answer was gone. Here the caller reads nothing until the process has ended.
// The request is the one the command sends, which asks for the connection to
// be closed after the answer.
test("a caller that has not read the answer when the gateway process ends still receives it", async (t) => {
  const g = await startChildGateway(t);
  const body = JSON.stringify({ waitSeconds: 5 });
  const socket = new net.Socket();
  t.after(() => socket.destroy());
  socket.pause();
  const failed = new Promise((resolve) => socket.once("error", (error) => resolve(`failed with ${error.code}`)));
  await new Promise((resolve) => socket.connect(g.port, "127.0.0.1", resolve));
  socket.write(`POST /dshproxy/control/stop HTTP/1.1\r\nHost: 127.0.0.1:${g.port}\r\nConnection: close\r\nx-dshproxy-token: ${g.token()}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
  // A caller that neither reads nor hangs up does not keep the process alive.
  assert.deepEqual(await g.ended(), { code: 0, signal: null });

  let text = "";
  socket.on("data", (chunk) => { text += chunk; });
  const whole = new Promise((resolve) => socket.once("end", () => resolve("the whole answer")));
  socket.resume();
  assert.equal(await Promise.race([whole, failed]), "the whole answer");
  assert.match(text, /^HTTP\/1\.1 200 OK\r\n/);
  assert.ok(text.endsWith('\r\n\r\n{"stopped":true}'), "the answer is not there");
});

test("a restart after a backend rollback waits for the request in flight, then the gateway serves again", async (t) => {
  // A lock file with a previous version to go back to: the shipped one.
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, "backend.lock.json"), "utf8"));
  delete shipped.previous;
  const g = await startChildGateway(t, (home) => fs.writeFileSync(path.join(home, "backend.lock.json"), JSON.stringify({ ...shipped, previous: shipped })));
  const firstToken = g.token();

  const held = call(g.port, { target: "/v1/models?delay=3000" });
  await held.firstPart;
  const rolled = await call(g.port, { method: "POST", target: "/dshproxy/control/update/rollback", headers: { "x-dshproxy-token": firstToken } }).done;
  assert.equal(rolled.status, 200, rolled.text);
  assert.equal(JSON.parse(rolled.text).ok, true);

  await until(() => /Restart requested with 1 request in flight/.test(g.output()), "the restart to wait", 10000);
  // The request the restart found in flight arrives whole.
  assert.deepEqual([(await held.done).status, held.state.text], [200, "first last"]);
  await until(() => (g.output().match(/listening on/g) || []).length === 2 || g.child.exitCode !== null, "the gateway to listen again", 20000);
  assert.equal(g.child.exitCode, null, g.output());
  assert.equal((await get(g.port, "/v1/models")).status, 200);
  assert.equal(JSON.parse((await get(g.port, "/dshproxy/status")).text).inFlight, 0);
  assert.doesNotMatch(g.output(), /cut|Restart failed|did not start/);
  assert.match(g.output(), /stopping at a moment with no request in flight/);
  assert.notEqual(g.token(), firstToken);

  const stopped = await cli(g.home, ["stop", "--when-idle", "--wait", "10"]);
  assert.deepEqual([stopped.status, stopped.stdout], [0, '{"stopped":true}\n']);
  assert.deepEqual(await g.ended(), { code: 0, signal: null });
  assert.equal(g.output().includes(firstToken), false);
});

// ------------------------------- the video picker's own path -------------------------------

test("a request for a video entry is answered by the gateway itself and never forwarded; a chat request beside it is forwarded as before", async (t) => {
  const g = await startGateway(t);
  const body = JSON.stringify({ model: "seedance-2.5/720p/krea", max_tokens: 4096, stream: true, messages: [{ role: "user", content: "A red ball rolls slowly across a wooden table" }] });
  const video = await call(g.port, { method: "POST", target: "/dshproxy/video/v1/messages", headers: { "content-type": "application/json" }, body }).done;
  assert.equal(video.status, 200);
  assert.match(video.headers["content-type"], /^text\/event-stream/);
  // No entry is switched on in this data folder: the picker says so, and asks nobody.
  assert.match(video.text, /This video entry is switched off in DSHProxy\. Nothing was quoted or bought\./);
  assert.match(video.text, /event: message_stop/);
  assert.deepEqual(g.backend.seen, [], "nothing reached the backend");

  // From a web page: refused at the door.
  const page = await call(g.port, { method: "POST", target: "/dshproxy/video/v1/messages", headers: { "content-type": "application/json", origin: "https://example.com" }, body }).done;
  assert.equal(page.status, 403);
  assert.deepEqual(g.backend.seen, []);

  // A chat request is forwarded whole, and the gateway's own status still answers.
  assert.deepEqual(JSON.parse((await get(g.port, "/v1/models?how=ok&id=chat")).text), { served: "chat" });
  assert.deepEqual(g.backend.seen.map((item) => item.id), ["chat"]);
  await idle(g);
  assert.equal((await liveStatus(g.port)).inFlight, 0);
  // The purchase record exists from the first start, so that it is old enough when it is needed.
  assert.ok(fs.existsSync(path.join(g.home, "video-picker", "claims.log")));
});
