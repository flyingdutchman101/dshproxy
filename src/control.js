// The local control API the Windows app uses while the gateway runs: sign-in,
// account removal and subscription limits.
//
// Every call needs the token written to ~/.dshgate/control.token when the
// gateway starts. A web page in the browser cannot read that file, and a
// request that carries an Origin header (which browsers always send) is
// refused, so a website cannot drive sign-in through the gateway.

const crypto = require("crypto");
const fs = require("fs");

const PREFIX = "/dshgate/control/";
const MAX_BODY = 64 * 1024;

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

function writeToken(file, token) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${token}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function sameToken(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("request body is not JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

// `routes` maps "METHOD name" to async (body, query) => result.
function createControl({ token, routes }) {
  return async function handle(req, res) {
    if (!req.url.startsWith(PREFIX)) return false;
    if (req.headers.origin) {
      send(res, 403, { error: "Requests from web pages are not accepted." });
      return true;
    }
    if (!sameToken(req.headers["x-dshgate-token"], token)) {
      send(res, 401, { error: "Missing or wrong control token." });
      return true;
    }
    const url = new URL(req.url, "http://localhost");
    const route = routes[`${req.method} ${url.pathname.slice(PREFIX.length)}`];
    if (!route) {
      send(res, 404, { error: "No such control call." });
      return true;
    }
    try {
      const body = req.method === "GET" ? {} : await readBody(req);
      send(res, 200, await route(body, Object.fromEntries(url.searchParams)));
    } catch (error) {
      send(res, error.status || 400, { error: error.message });
    }
    return true;
  };
}

module.exports = { PREFIX, newToken, writeToken, createControl };
