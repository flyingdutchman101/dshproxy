const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const { createControl } = require("../src/control");

const TOKEN = "a".repeat(64);

async function start(t, routes) {
  const control = createControl({ token: TOKEN, routes });
  const server = http.createServer((req, res) => {
    control(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("not control");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/dshproxy/control/`;
}

test("a call with the right token reaches its route with the body and query", async (t) => {
  const seen = [];
  const base = await start(t, {
    "POST login/start": async (body, query) => {
      seen.push({ body, query });
      return { ok: true };
    }
  });
  const response = await fetch(`${base}login/start?x=1`, { method: "POST", headers: { "x-dshproxy-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ provider: "claude" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(seen, [{ body: { provider: "claude" }, query: { x: "1" } }]);
});

test("a route is given the request and the response of its call", async (t) => {
  const seen = [];
  const base = await start(t, {
    "POST stop": async (_body, _query, call) => {
      seen.push([call.req.method, call.req.url, call.req.socket === call.res.socket]);
      call.res.setHeader("connection", "close");
      return { ok: true };
    },
    "GET plain": async () => ({ ok: true })
  });
  const closing = await fetch(`${base}stop`, { method: "POST", headers: { "x-dshproxy-token": TOKEN } });
  assert.deepEqual(await closing.json(), { ok: true });
  assert.equal(closing.headers.get("connection"), "close");
  assert.equal(closing.headers.get("content-type"), "application/json");
  assert.deepEqual(seen, [["POST", "/dshproxy/control/stop", true]]);
  const plain = await fetch(`${base}plain`, { headers: { "x-dshproxy-token": TOKEN } });
  assert.notEqual(plain.headers.get("connection"), "close");
});

test("a call without the token, or with a wrong one, is refused before any route runs", async (t) => {
  let ran = false;
  const base = await start(t, { "POST login/start": async () => { ran = true; return {}; } });
  for (const headers of [{}, { "x-dshproxy-token": "b".repeat(64) }, { "x-dshproxy-token": "short" }]) {
    const response = await fetch(`${base}login/start`, { method: "POST", headers });
    assert.equal(response.status, 401);
  }
  assert.equal(ran, false);
});

test("a call from a web page is refused even with the token", async (t) => {
  let ran = false;
  const base = await start(t, { "POST login/start": async () => { ran = true; return {}; } });
  const response = await fetch(`${base}login/start`, { method: "POST", headers: { "x-dshproxy-token": TOKEN, origin: "https://evil.example" } });
  assert.equal(response.status, 403);
  assert.equal(ran, false);
});

test("an error in a route is returned with its message", async (t) => {
  const base = await start(t, { "GET limits": async () => { throw new Error("backend did not answer"); } });
  const response = await fetch(`${base}limits`, { headers: { "x-dshproxy-token": TOKEN } });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "backend did not answer" });
});

test("an unknown call and a body that is not JSON are refused", async (t) => {
  const base = await start(t, { "POST login/start": async () => ({}) });
  assert.equal((await fetch(`${base}nothing`, { headers: { "x-dshproxy-token": TOKEN } })).status, 404);
  const bad = await fetch(`${base}login/start`, { method: "POST", headers: { "x-dshproxy-token": TOKEN }, body: "{not json" });
  assert.equal(bad.status, 400);
});

test("requests outside the control path are left to the gateway", async (t) => {
  const base = await start(t, {});
  const response = await fetch(base.replace("/dshproxy/control/", "/v1/models"));
  assert.equal(await response.text(), "not control");
});
