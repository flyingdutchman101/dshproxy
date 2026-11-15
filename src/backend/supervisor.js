// Runs CLIProxyAPI as a child process and restarts it if it dies.

const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, execFile } = require("child_process");

const RESTART_WINDOW_MS = 5 * 60 * 1000;
const MAX_RESTARTS = 5;

function portInUse(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function answers(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/v1/models", timeout: 2000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Full path of a running process's program, or null when there is no such
// process or Windows will not say.
function windowsProcessPath(pid) {
  const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve) => {
    execFile(exe, ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).Path`], { windowsHide: true, timeout: 15000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null);
    });
  });
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// A gateway that was killed leaves its backend running and holding the port.
// The backend's process ID is recorded when it starts; it is stopped here only
// when that process is still this gateway's own backend program. A process ID
// that now belongs to anything else (including another program's
// cli-proxy-api.exe) is left alone.
async function reclaimOrphan({ pidFile, binary, processPath = windowsProcessPath, kill = (pid) => process.kill(pid) }) {
  let pid;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const running = await processPath(pid);
  if (!running || !samePath(running, binary)) return false;
  try {
    kill(pid);
    return true;
  } catch {
    return false;
  }
}

function createSupervisor({ binary, configPath, host, port, pidFile = null, log = () => {} }) {
  let child = null;
  let stopping = false;
  let restartTimer = null;
  const restarts = [];

  const recordPid = (pid) => {
    if (!pidFile || !pid) return;
    try {
      fs.writeFileSync(pidFile, `${pid}\n`);
    } catch {
      // Without the record a killed gateway's backend has to be stopped by hand.
    }
  };

  function launch() {
    const proc = spawn(binary, ["-config", configPath], { cwd: path.dirname(binary), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child = proc;
    recordPid(proc.pid);
    const relay = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) log(`backend: ${line.trim()}`);
    };
    proc.stdout.on("data", relay);
    proc.stderr.on("data", relay);
    proc.on("error", (error) => log(`backend could not start: ${error.message}`));
    proc.on("exit", (code) => {
      if (child === proc) child = null;
      if (stopping) return;
      log(`backend exited with code ${code}`);
      scheduleRestart();
    });
    return proc;
  }

  // Stops retrying when the backend keeps dying, so a broken setup does not
  // loop forever.
  function scheduleRestart() {
    const now = Date.now();
    while (restarts.length && now - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
    if (restarts.length >= MAX_RESTARTS) {
      log("backend keeps exiting; not restarting again. Fix the cause, then restart dshgate.");
      return;
    }
    restarts.push(now);
    restartTimer = setTimeout(() => {
      if (!stopping) launch();
    }, 1000 * restarts.length);
  }

  // Never stops another program to free the port: VeryCuteDroidProxy or a
  // second dshgate may own it.
  async function start({ timeoutMs = 30000 } = {}) {
    if (pidFile && await reclaimOrphan({ pidFile, binary })) {
      log("stopped a backend left running by an earlier dshgate");
      for (let attempt = 0; attempt < 20 && await portInUse(host, port); attempt += 1) await sleep(250);
    }
    if (await portInUse(host, port)) throw new Error(`Port ${port} is already in use. Stop the program using it or change "backendPort" in settings.json.`);
    stopping = false;
    const proc = launch();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child !== proc) throw new Error("The backend exited while starting. See the log lines above.");
      if (await answers(host, port)) {
        log(`backend ready on ${host}:${port} (PID ${proc.pid})`);
        return;
      }
      await sleep(300);
    }
    stop();
    throw new Error(`The backend did not answer on ${host}:${port} within ${Math.round(timeoutMs / 1000)}s.`);
  }

  function stop() {
    stopping = true;
    clearTimeout(restartTimer);
    if (child) child.kill();
    child = null;
    if (pidFile) fs.rmSync(pidFile, { force: true });
  }

  return { start, stop, state: () => ({ running: Boolean(child), pid: child?.pid ?? null, restarts: restarts.length }) };
}

module.exports = { createSupervisor, reclaimOrphan, portInUse };
