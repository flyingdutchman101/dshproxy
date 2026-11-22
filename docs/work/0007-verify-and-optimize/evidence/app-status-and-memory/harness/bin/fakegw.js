'use strict';
// A stand-in gateway for seam checks of the Windows app. It answers
// GET /dshproxy/status in the daemon's shape on a spare loopback port and
// nothing else, and does what small text files tell it:
//   inflight N    report N requests in flight
//   mute, unmute  stop and resume answering (connections are dropped)
//   exit-in MS    end this process, with exit code 0, after MS milliseconds
// With FAKE_GW_CONTROL set it also answers the control call for a model tick.
// Usage: node fakegw.js <port> <command file> <log file> [born-mute] [limits file]
const fs = require('fs');
const http = require('http');

function run(port, commandFile, logFile, bornMute, limitsFile) {
  if (!Number.isInteger(port) || [8417, 8418].includes(port)) throw new Error('the stand-in gateway needs a spare port');
  const log = (line) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${process.pid} [fake] ${line}\n`);
  let inFlight = 0;
  let mute = Boolean(bornMute);
  const startedAt = new Date().toISOString();
  const server = http.createServer((req, res) => {
    if (mute) { req.socket.destroy(); return; }
    if (req.method === 'GET' && req.url === '/dshproxy/status') {
      const body = JSON.stringify({ version: '0.1.0', startedAt, origin: `http://127.0.0.1:${port}`, inFlight, backend: { name: 'CLIProxyAPI', version: '8.0.72', running: true, pid: 4242, restarts: 0 }, update: null, lanes: [], accounts: [] });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (limitsFile && req.method === 'GET' && req.url.startsWith('/dshproxy/control/limits')) {
      const body = fs.readFileSync(limitsFile, 'utf8').replace(/^\uFEFF/, '');
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    // With FAKE_GW_CONTROL set: the control call the app makes for a ticked
    // model is written to the log and answered; nothing is saved anywhere.
    if (process.env.FAKE_GW_CONTROL && req.method === 'POST' && req.url === '/dshproxy/control/models/choose') {
      let text = '';
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', () => {
        log(`control: POST models/choose ${text}`);
        try {
          const file = `.choices`;
          const choices = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
          const { id, offered } = JSON.parse(text);
          choices[id] = Boolean(offered);
          fs.writeFileSync(file, JSON.stringify(choices));
        } catch { /* a call that is not JSON is only logged */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true,"harnessChanged":false}');
      });
      return;
    }
    if (process.env.FAKE_GW_CONTROL && req.method === 'GET' && req.url.startsWith('/dshproxy/control/limits')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"accounts":[]}');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not here"}');
  });
  server.listen(port, '127.0.0.1', () => {
    log(`listening on http://127.0.0.1:${port}${mute ? ' (not answering)' : ''}`);
    if (process.env.FAKE_GW_CONTROL) fs.writeFileSync(require('path').join(process.env.DSHPROXY_HOME, 'control.token'), 'synthetic-token-for-the-stand-in');
    console.log(`stand-in gateway listening on http://127.0.0.1:${port}`);
  });
  const obey = (file) => {
    if (!fs.existsSync(file)) return;
    let command = '';
    try { command = fs.readFileSync(file, 'utf8').trim(); fs.rmSync(file, { force: true }); } catch { return; }
    const [what, value] = command.split(/\s+/);
    if (what === 'inflight') inFlight = Number(value) || 0;
    else if (what === 'mute') mute = true;
    else if (what === 'unmute') mute = false;
    else if (what === 'exit-in') setTimeout(() => { log('ending by itself, exit code 0'); process.exit(0); }, Number(value) || 0);
    log(`told: ${command}`);
  };
  setInterval(() => { obey(commandFile); obey(`${commandFile}.stop`); }, 40);
}

module.exports = { run };
if (require.main === module) {
  const [port, commandFile, logFile, bornMute, limitsFile] = process.argv.slice(2);
  run(Number(port), commandFile, logFile, bornMute === 'born-mute', limitsFile);
}
