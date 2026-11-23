// Starts the real gateway in a throwaway data folder, checks that it answers,
// stops it with `stop --when-idle`, and checks that nothing is left running
// (docs/work/0014-macos-port, criterion C2). Downloads the pinned CLIProxyAPI
// release (about 24 MB). Used by CI on macOS; can be run by hand:
//   node scripts/start-stop-check.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const cli = path.join(root, "bin", "dshproxy.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dshproxy-start-stop-"));
  const home = path.join(base, "data");
  fs.mkdirSync(home);
  const port = await freePort();
  const backendPort = await freePort();
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ port, backendPort }));
  const env = { ...process.env, DSHPROXY_HOME: home, DSH_HOME: path.join(base, "no-harness") };
  const gateway = spawn(process.execPath, [cli, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  gateway.stdout.on("data", (chunk) => { output += chunk; });
  gateway.stderr.on("data", (chunk) => { output += chunk; });
  const fail = (why) => {
    gateway.kill("SIGKILL");
    console.error(`FAIL ${why}\n--- gateway output ---\n${output}`);
    process.exit(1);
  };

  let status = null;
  for (let tries = 0; tries < 240 && !status; tries += 1) {
    await sleep(500);
    if (gateway.exitCode !== null) fail(`the gateway exited with code ${gateway.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/dshproxy/status`);
      if (response.ok) status = await response.json();
    } catch {
      // not yet
    }
  }
  if (!status) fail("GET /dshproxy/status did not answer within 120 seconds");
  console.log(`ok   GET /dshproxy/status answered; backend ${status.backend?.name} ${status.backend?.version}`);
  const program = fs.readdirSync(path.join(home, "bin")).map((version) => path.join(home, "bin", version, process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api")).find((file) => fs.existsSync(file));
  if (!program) fail("no installed backend program");

  const stopped = spawnSync(process.execPath, [cli, "stop", "--when-idle", "--wait", "30"], { env, encoding: "utf8", timeout: 90000 });
  if (stopped.status !== 0 || stopped.stdout.trim() !== '{"stopped":true}') fail(`stop --when-idle: exit ${stopped.status}, ${stopped.stdout}${stopped.stderr}`);
  console.log("ok   stop --when-idle stopped the gateway");
  for (let tries = 0; tries < 40 && gateway.exitCode === null; tries += 1) await sleep(250);
  if (gateway.exitCode === null) fail("the gateway process did not end");

  if (process.platform !== "win32") {
    const left = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,comm="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.includes(program));
    if (left.length) fail(`a backend is still running: ${left.join("; ")}`);
    console.log("ok   no backend process is left");
  }
  fs.rmSync(base, { recursive: true, force: true });
  console.log("start-stop check passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
