// Browser sign-in for subscription accounts.
//
// The backend creates the sign-in link and exchanges the code for tokens. The
// provider sends the browser back to a fixed localhost address; dshgate
// listens there on loopback only, hands the address to the backend, and shows
// the user a confirmation page. Kimi uses a device code instead: the user
// enters a short code on Kimi's page and no address is needed.

const http = require("http");
const { URL } = require("url");

const PROVIDERS = {
  claude: { label: "Claude", route: "anthropic-auth-url", backendName: "anthropic", callback: { port: 54545, path: "/callback" } },
  codex: { label: "ChatGPT (Codex)", route: "codex-auth-url", backendName: "codex", callback: { port: 1455, path: "/auth/callback" } },
  antigravity: { label: "Gemini (Antigravity)", route: "antigravity-auth-url", backendName: "antigravity", callback: { port: 51121, path: "/oauth-callback" } },
  kimi: { label: "Kimi", route: "kimi-auth-url", backendName: "kimi", callback: null }
};

const SESSION_MS = 5 * 60 * 1000;

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function page(title, message, ok) {
  const color = ok ? "#16803d" : "#b91c1c";
  const mark = ok ? "&#10003;" : "!";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:"Segoe UI",system-ui,sans-serif;background:#f4f5f7;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);padding:40px 48px;max-width:440px;text-align:center}
.mark{width:56px;height:56px;border-radius:50%;background:${color};color:#fff;font-size:30px;line-height:56px;margin:0 auto 16px}
h1{font-size:20px;margin:0 0 8px;color:#111}p{color:#555;margin:0;line-height:1.5}</style></head>
<body><main class="card"><div class="mark">${mark}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

// Listens on the provider's redirect address, on loopback only. Both the IPv4
// and the IPv6 loopback are tried, because "localhost" can resolve to either.
// If another program holds the port on either one, the browser could land on
// that program, so the sign-in is refused. An IPv6 loopback that this machine
// does not have is not an error.
function listenLoopback(port, handler) {
  const attempt = (host) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.once("error", (error) => resolve({ error }));
    server.listen(port, host, () => resolve({ server }));
  });
  return Promise.all([attempt("127.0.0.1"), attempt("::1")]).then((results) => {
    const servers = results.filter((result) => result.server).map((result) => result.server);
    const close = () => {
      for (const server of servers) {
        server.closeAllConnections();
        server.close();
      }
    };
    const busy = results.find((result) => result.error?.code === "EADDRINUSE");
    const failed = results[0].error;
    if (busy || failed) {
      close();
      const error = busy ? busy.error : failed;
      throw new Error(error.code === "EADDRINUSE"
        ? `Port ${port} is in use by another program, so the browser cannot return here. Close it (often another proxy app or a sign-in left open) and try again.`
        : `Could not listen on port ${port}: ${error.message}`);
    }
    return close;
  });
}

// `credentials()` returns the backend's credential list; it is used to name
// the account that was added.
function createLogins({ management, log = () => {}, now = Date.now, listen = listenLoopback }) {
  const sessions = new Map();

  function finish(session) {
    if (session.close) session.close();
    session.close = null;
    clearTimeout(session.timer);
  }

  async function start(providerKey) {
    const provider = PROVIDERS[providerKey];
    if (!provider) throw new Error(`Unknown service "${providerKey}". Use one of: ${Object.keys(PROVIDERS).join(", ")}.`);
    // A new sign-in for the same service replaces one that is still open.
    for (const [state, session] of sessions) {
      if (session.provider === providerKey && session.status === "wait") await cancel(state);
    }

    const before = new Set((await management.credentials()).map((item) => item.name));
    const started = await management.startLogin(provider.route);
    if (!started?.url || !started?.state) throw new Error(`The backend did not return a sign-in link for ${provider.label}.`);

    const session = { provider: providerKey, state: started.state, status: "wait", error: null, account: null, before, close: null, timer: null };
    sessions.set(started.state, session);

    if (provider.callback) {
      try {
        session.close = await listen(provider.callback.port, (req, res) => {
          handleRedirect(session, provider, req, res).catch((error) => {
            log(`sign-in for ${provider.label}: ${error.message}`);
          });
        });
      } catch (error) {
        sessions.delete(started.state);
        await management.cancelLogin(started.state).catch(() => {});
        throw error;
      }
    }
    session.timer = setTimeout(() => {
      if (session.status !== "wait") return;
      session.status = "error";
      session.error = "The sign-in was not finished within 5 minutes.";
      finish(session);
      management.cancelLogin(session.state).catch(() => {});
    }, SESSION_MS);
    session.timer.unref?.();

    log(`sign-in for ${provider.label} started`);
    return {
      id: started.state,
      provider: providerKey,
      label: provider.label,
      url: started.url,
      flow: started.flow === "device" ? "device" : "browser",
      userCode: started.user_code || null,
      expiresIn: Number(started.expires_in) || null
    };
  }

  async function handleRedirect(session, provider, req, res) {
    const address = new URL(req.url, `http://localhost:${provider.callback.port}`);
    const send = (status, title, message, ok) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page(title, message, ok));
    };
    if (address.pathname !== provider.callback.path || address.searchParams.get("state") !== session.state) {
      send(404, "Not found", "This address only finishes a dshgate sign-in.", false);
      return;
    }
    const denied = address.searchParams.get("error");
    try {
      await management.submitCallback(provider.backendName, address.href);
    } catch (error) {
      send(400, "Sign-in failed", `dshgate could not finish the sign-in: ${error.message}`, false);
      return;
    }
    if (denied) {
      send(200, "Sign-in cancelled", `${provider.label} reported: ${address.searchParams.get("error_description") || denied}. You can close this tab.`, false);
      return;
    }
    send(200, `Signed in to ${provider.label}`, "You can close this tab and go back to dshgate.", true);
  }

  async function status(id) {
    const session = sessions.get(id);
    if (!session) return { status: "error", error: "This sign-in is no longer open." };
    if (session.status !== "wait") return { status: session.status, error: session.error, account: session.account };
    let reply;
    try {
      reply = await management.loginStatus(id);
    } catch (error) {
      return { status: "wait", error: null, account: null, note: error.message };
    }
    if (reply?.status === "ok") {
      session.status = "ok";
      finish(session);
      try {
        const added = (await management.credentials()).find((item) => !session.before.has(item.name));
        session.account = added ? String(added.email || added.account || added.label || added.name) : null;
      } catch {
        session.account = null;
      }
      log(`signed in to ${PROVIDERS[session.provider].label}${session.account ? ` as ${session.account}` : ""}`);
    } else if (reply?.status === "error") {
      session.status = "error";
      session.error = String(reply.error || "The sign-in failed.");
      finish(session);
    }
    return { status: session.status, error: session.error, account: session.account };
  }

  async function cancel(id) {
    const session = sessions.get(id);
    if (!session) return false;
    if (session.status === "wait") {
      session.status = "error";
      session.error = "Cancelled.";
      await management.cancelLogin(id).catch(() => {});
    }
    finish(session);
    sessions.delete(id);
    return true;
  }

  function closeAll() {
    for (const session of sessions.values()) finish(session);
    sessions.clear();
  }

  return { start, status, cancel, closeAll };
}

module.exports = { PROVIDERS, createLogins, listenLoopback, page };
