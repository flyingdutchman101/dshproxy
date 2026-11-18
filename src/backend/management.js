// Client for CLIProxyAPI's Management API. The backend listens on loopback
// only, and every call carries the key the gateway generated for this run.
// Tokens never pass through here: the backend inserts them itself when it
// makes a call on an account's behalf (`$TOKEN$`).

const http = require("http");

function createManagement({ host, port, key, timeoutMs = 30000 }) {
  function request(method, path, body) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    return new Promise((resolve, reject) => {
      const req = http.request({
        host,
        port,
        method,
        path,
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json",
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {})
        }
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          if (res.statusCode >= 400) {
            const message = json?.error?.message || json?.error || text || `HTTP ${res.statusCode}`;
            const error = new Error(String(message));
            error.status = res.statusCode;
            reject(error);
            return;
          }
          resolve(json);
        });
      });
      req.on("timeout", () => req.destroy(new Error("the backend did not answer in time")));
      req.on("error", reject);
      req.end(payload || undefined);
    });
  }

  const query = (params) => new URLSearchParams(params).toString();

  return {
    // Credentials the backend has loaded, with their index and live state.
    async credentials() {
      const result = await request("GET", "/v0/management/auth-files");
      return Array.isArray(result?.files) ? result.files : [];
    },
    // Starts a sign-in. Returns { url, state, flow, user_code, expires_in }.
    startLogin(route) {
      return request("GET", `/v0/management/${route}`);
    },
    loginStatus(state) {
      return request("GET", `/v0/management/get-auth-status?${query({ state })}`);
    },
    cancelLogin(state) {
      return request("DELETE", `/v0/management/oauth-session?${query({ state })}`);
    },
    // Hands the browser's redirect to the backend, which finishes the sign-in.
    submitCallback(provider, redirectUrl) {
      return request("POST", "/v0/management/oauth-callback", { provider, redirect_url: redirectUrl });
    },
    deleteCredential(name) {
      return request("DELETE", `/v0/management/auth-files?${query({ name })}`);
    },
    setDisabled(name, disabled) {
      return request("PATCH", "/v0/management/auth-files/status", { name, disabled });
    },
    // A larger priority is picked first; 0 puts the credential back among the
    // rest. Each credential in credentials() carries its `priority` when set.
    setPriority(name, priority) {
      return request("PATCH", "/v0/management/auth-files/fields", { name, priority });
    },
    // An HTTP call made by the backend with the account's own token.
    apiCall({ authIndex, method = "GET", url, header = {}, data }) {
      return request("POST", "/v0/management/api-call", { auth_index: authIndex, method, url, header, ...(data === undefined ? {} : { data }) });
    }
  };
}

module.exports = { createManagement };
