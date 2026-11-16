const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const { createLogins, listenLoopback } = require("../src/login");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// A stand-in for the backend's Management API. The test decides when a
// sign-in completes by what the callback carries.
function fakeManagement() {
  const state = { credentials: [{ name: "old.json", email: "old@example.com" }], sessions: new Map(), callbacks: [], cancelled: [] };
  return {
    state,
    credentials: async () => state.credentials,
    startLogin: async (route) => {
      state.started = (state.started || 0) + 1;
      const id = `state-${state.started}`;
      state.sessions.set(id, "wait");
      if (route === "kimi-auth-url") return { status: "ok", url: "https://www.kimi.com/device", state: id, flow: "device", user_code: "ABCD-1234", expires_in: 1800 };
      return { status: "ok", url: `https://provider.example/authorize?state=${id}`, state: id };
    },
    loginStatus: async (id) => {
      const status = state.sessions.get(id);
      if (!status) return { status: "error", error: "unknown or expired state" };
      return status === "ok" ? { status: "ok" } : status === "wait" ? { status: "wait" } : { status: "error", error: status };
    },
    cancelLogin: async (id) => {
      state.cancelled.push(id);
      state.sessions.delete(id);
      return { status: "ok" };
    },
    submitCallback: async (provider, redirectUrl) => {
      state.callbacks.push({ provider, redirectUrl });
      const address = new URL(redirectUrl);
      const id = address.searchParams.get("state");
      if (address.searchParams.get("error")) state.sessions.set(id, "access_denied");
      else {
        state.sessions.set(id, "ok");
        state.credentials = [...state.credentials, { name: "claude-new.json", email: "new@example.com" }];
      }
      return { status: "ok" };
    }
  };
}

// The real loopback listener, on a free port instead of the provider's fixed one.
function freePortListen(ports) {
  return async (_fixedPort, handler) => {
    const server = http.createServer(handler);
    const port = await listen(server);
    ports.push(port);
    return () => {
      server.closeAllConnections();
      server.close();
    };
  };
}

test("a browser sign-in finishes when the provider sends the browser back, and names the new account", async (t) => {
  const management = fakeManagement();
  const ports = [];
  const logins = createLogins({ management, listen: freePortListen(ports) });
  t.after(() => logins.closeAll());

  const started = await logins.start("claude");
  assert.equal(started.flow, "browser");
  assert.match(started.url, /^https:\/\/provider\.example\/authorize/);
  assert.deepEqual(await logins.status(started.id), { status: "wait", error: null, account: null });

  const page = await fetch(`http://127.0.0.1:${ports[0]}/callback?code=abc&state=${started.id}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Signed in to Claude/);
  assert.equal(management.state.callbacks[0].provider, "anthropic");
  assert.match(management.state.callbacks[0].redirectUrl, /code=abc/);

  assert.deepEqual(await logins.status(started.id), { status: "ok", error: null, account: "new@example.com" });
});

test("the browser page says so when the user declines", async (t) => {
  const management = fakeManagement();
  const ports = [];
  const logins = createLogins({ management, listen: freePortListen(ports) });
  t.after(() => logins.closeAll());
  const started = await logins.start("claude");
  const page = await fetch(`http://127.0.0.1:${ports[0]}/callback?error=access_denied&error_description=User%20denied&state=${started.id}`);
  assert.match(await page.text(), /Sign-in cancelled[\s\S]*User denied/);
  const status = await logins.status(started.id);
  assert.equal(status.status, "error");
  assert.match(status.error, /access_denied/);
});

test("a redirect with another sign-in's state is refused and not passed on", async (t) => {
  const management = fakeManagement();
  const ports = [];
  const logins = createLogins({ management, listen: freePortListen(ports) });
  t.after(() => logins.closeAll());
  await logins.start("claude");
  const page = await fetch(`http://127.0.0.1:${ports[0]}/callback?code=abc&state=someone-else`);
  assert.equal(page.status, 404);
  assert.equal(management.state.callbacks.length, 0);
});

test("a device sign-in returns the code to show and finishes without a redirect", async (t) => {
  const management = fakeManagement();
  let listened = false;
  const logins = createLogins({ management, listen: async () => { listened = true; return () => {}; } });
  t.after(() => logins.closeAll());
  const started = await logins.start("kimi");
  assert.deepEqual([started.flow, started.userCode, started.expiresIn], ["device", "ABCD-1234", 1800]);
  assert.equal(listened, false);
  management.state.sessions.set(started.id, "ok");
  assert.equal((await logins.status(started.id)).status, "ok");
});

test("cancelling tells the backend and frees the redirect address", async (t) => {
  const management = fakeManagement();
  const ports = [];
  const logins = createLogins({ management, listen: freePortListen(ports) });
  t.after(() => logins.closeAll());
  const started = await logins.start("codex");
  assert.equal(await logins.cancel(started.id), true);
  assert.deepEqual(management.state.cancelled, [started.id]);
  await assert.rejects(fetch(`http://127.0.0.1:${ports[0]}/auth/callback?state=${started.id}`));
  assert.equal((await logins.status(started.id)).status, "error");
});

test("starting the same service again replaces the open sign-in", async (t) => {
  const management = fakeManagement();
  const logins = createLogins({ management, listen: freePortListen([]) });
  t.after(() => logins.closeAll());
  const first = await logins.start("claude");
  const second = await logins.start("claude");
  assert.notEqual(first.id, second.id);
  assert.deepEqual(management.state.cancelled, [first.id]);
});

test("a redirect address held by another program gives a clear error and leaves no sign-in open", async (t) => {
  // Held on the IPv4 loopback only: an IPv6 listener on the same port would
  // still succeed, and the browser could reach the other program.
  const blocker = http.createServer();
  const port = await listen(blocker);
  t.after(() => blocker.close());
  const probe = http.createServer();
  const ipv6Free = await new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(port, "::1", () => probe.close(() => resolve(true)));
  });
  assert.equal(ipv6Free, true, "this test needs the IPv6 loopback to be free on the port");
  const management = fakeManagement();
  const logins = createLogins({ management, listen: (_fixed, handler) => listenLoopback(port, handler) });
  t.after(() => logins.closeAll());
  await assert.rejects(logins.start("claude"), /in use by another program/);
  assert.equal(management.state.cancelled.length, 1);
});

test("an unknown service is refused", async () => {
  const logins = createLogins({ management: fakeManagement() });
  await assert.rejects(logins.start("myspace"), /Unknown service/);
});
