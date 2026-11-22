'use strict';
// Stand-in for bin\dshproxy.js in a seam check of the Windows app. Every
// command is passed on to the real command line of the worktree, except as
// the words in STUB_MODE_FILE say:
//   start             runs the real daemon with the seam its own tests use: no
//                     backend program is installed or started, a small local
//                     server stands in for it, and nothing but the two spare
//                     loopback ports of the throwaway data folder can be reached.
//                     With "fake": the stand-in gateway of fakegw.js instead
//                     ("born-mute": one that does not answer).
//   stop --when-idle  "old-cli": answers as a DSHProxy from before the command
//                     "short-wait": waits 2 seconds instead of 300
//                     "commit:MS": the gateway ends itself after MS milliseconds
//                       ("never": it does not) and the command hangs until ended
//                     "lost:MS": the same, and the command says at once that the
//                       answer did not arrive, exit code 1
//                     "busy": says one request is still in flight, exit code 2
//   status            "slow-status": takes 5 seconds longer
// Every start and end of a command is written to STUB_LOG with its time.
const fs = require('fs');
const http = require('http');
const path = require('path');

const args = process.argv.slice(2);
const real = process.env.DSHPROXY_REAL_ROOT;
const home = process.env.DSHPROXY_HOME;
if (!real || !home || !process.env.DSH_HOME || !process.env.STUB_LOG) throw new Error('the stand-in command line needs its environment');
const note = (what) => fs.appendFileSync(process.env.STUB_LOG, `${new Date().toISOString()} ${what} ${process.pid} ${args.join(' ')}\n`);
note('begin');
process.on('exit', (code) => note(`end(${code})`));
const words = (() => { try { return fs.readFileSync(process.env.STUB_MODE_FILE, 'utf8').trim().split(/\s+/).filter(Boolean); } catch { return []; } })();
const has = (word) => words.includes(word);
const valueOf = (name) => { const word = words.find((item) => item.startsWith(`${name}:`)); return word ? word.slice(name.length + 1) : null; };

function ports() {
  const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8').replace(/^\uFEFF/, ''));
  const { port, backendPort } = settings;
  if (!port || !backendPort || [8417, 8418].includes(port) || [8417, 8418].includes(backendPort)) throw new Error('the throwaway settings must name spare ports');
  return { port, backendPort };
}

function startDaemon() {
  const { port, backendPort } = ports();
  const log = (line) => fs.appendFileSync(process.env.STUB_GATEWAY_LOG, `${new Date().toISOString()} ${process.pid} ${line}\n`);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    const target = new URL(String(url));
    if (target.hostname !== '127.0.0.1' || ![port, backendPort].includes(Number(target.port))) throw new Error(`network is forbidden here: ${target.origin}`);
    return realFetch(url, options);
  };
  const held = [];
  const backend = http.createServer((req, res) => {
    res.on('error', () => {});
    req.on('error', () => {});
    req.resume();
    req.on('end', () => {
      if (req.url.includes('how=hold')) { held.push(res); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
  });
  backend.listen(backendPort, '127.0.0.1', async () => {
    const daemon = require(path.join(real, 'src', 'daemon'));
    const supervisor = { start: async () => {}, stop: async () => {}, state: () => ({ running: true, pid: 4242, restarts: 0 }) };
    const gateway = await daemon.start({
      home,
      print: (line) => { log(`[gateway] ${line}`); console.log(line); },
      exit: () => { log('the gateway ended its own process, exit code 0'); process.exit(0); },
      backend: { install: async () => ({ path: path.join(home, 'no-backend-program'), installed: false }), createSupervisor: () => supervisor }
    });
    log(`listening on ${gateway.origin}`);
    let flight = 0;
    setInterval(() => {
      const file = process.env.STUB_COMMAND_FILE;
      if (!fs.existsSync(file)) return;
      let command = '';
      try { command = fs.readFileSync(file, 'utf8').trim(); fs.rmSync(file, { force: true }); } catch { return; }
      if (command === 'hold') {
        flight += 1;
        const id = flight;
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/v1/models?how=hold', agent: false }, (res) => {
          res.resume();
          res.on('end', () => log(`held request ${id} finished whole with HTTP ${res.statusCode}`));
          res.on('error', () => log(`held request ${id} WAS CUT while answering`));
        });
        req.on('error', (error) => log(`held request ${id} WAS CUT: ${error.code || error.message}`));
        req.end();
        log(`holding request ${id}`);
      } else if (command === 'release') {
        for (const res of held.splice(0)) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('done'); }
        log('released the held requests');
      }
    }, 100);
  });
}

const tellGateway = (ms) => { if (ms !== 'never') fs.writeFileSync(`${process.env.STUB_COMMAND_FILE}.stop`, `exit-in ${Number(ms) || 0}`); };

if (args[0] === 'start') {
  if (has('fake')) require('./fakegw').run(ports().port, process.env.STUB_COMMAND_FILE, process.env.STUB_GATEWAY_LOG, has('born-mute'));
  else startDaemon();
} else if (args[0] === 'stop' && has('old-cli')) {
  console.error('DSHProxy: Unknown command "stop". Run `dshproxy help`.');
  process.exit(1);
} else if (args[0] === 'stop' && valueOf('commit') !== null) {
  tellGateway(valueOf('commit'));
  setInterval(() => {}, 1000);
} else if (args[0] === 'stop' && valueOf('lost') !== null) {
  tellGateway(valueOf('lost'));
  console.error("DSHProxy: The gateway's answer did not arrive: the connection was lost. It may or may not have stopped; check with `dshproxy status`.");
  process.exit(1);
} else if (args[0] === 'stop' && has('busy')) {
  console.log('{"stopped":false,"inFlight":1}');
  process.exit(2);
} else {
  if (args[0] === 'stop' && has('short-wait')) {
    const at = process.argv.indexOf('--wait');
    if (at > 0) process.argv[at + 1] = '2';
  }
  // Mode word `models`: the status answer gets rows for the Models page (a
  // gateway without accounts lists none). Everything else in it is the real answer.
  if (args[0] === 'status' && has('models')) {
    const chunks = [];
    process.stdout.write = (chunk, encoding, done) => {
      chunks.push(Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
      const after = typeof encoding === 'function' ? encoding : done;
      if (after) after();
      return true;
    };
    process.on('exit', () => {
      let text = Buffer.concat(chunks).toString('utf8');
      try {
        const answer = JSON.parse(text);
        const row = (id, account, offered, reason) => ({ id, name: id, account, contextWindow: 200000, maxTokens: 64000, efforts: ['low', 'medium', 'high'], offered, reason, isNew: false });
        answer.modelList = [row('synthetic-model-a', 'claude', true, 'known'), row('synthetic-model-b', 'codex', true, 'known'), row('synthetic-model-c', 'codex', true, 'switched on'), row('synthetic-model-d', 'kimi', false, 'switched off')];
        // What the stand-in gateway was told since: a row follows the last choice made for it.
        let choices = {};
        try { choices = JSON.parse(fs.readFileSync(`.choices`, 'utf8')); } catch { /* none yet */ }
        for (const model of answer.modelList) if (model.id in choices) { model.offered = choices[model.id]; model.reason = choices[model.id] ? 'known' : 'switched off'; }
        text = JSON.stringify(answer);
      } catch { /* not JSON: passed on as it is */ }
      fs.writeSync(1, text);
    });
  }  const run = () => require(path.join(real, 'bin', 'dshproxy.js'));
  if (args[0] === 'status' && has('slow-status')) setTimeout(run, 5000);
  else run();
}
