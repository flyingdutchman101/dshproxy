'use strict';
const { spawn } = require('node:child_process');

// Only this process resolves the encrypted credential and loads the paid command.
async function execute(input, context = {}) {
  if (!input || !['boards', 'search'].includes(input.operation)) throw new Error('Invalid operation');
  const args = input.operation === 'boards' ? ['boards'] : ['search', '--query', input.query];
  let output;
  await require('../research/command').run([...args, '--confirm-credits'], text => { output = JSON.parse(text); }, { ...context, home: input.home });
  return output;
}

function runPaid(input, { signal, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    const allowed = {};
    for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'LOCALAPPDATA', 'FOREPLAY_API_KEY']) {
      if (typeof env[name] === 'string') allowed[name] = env[name];
    }
    const child = spawn(process.execPath, [__filename], { env: allowed, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    let text = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error('Cancelled'));
    const timer = setTimeout(() => finish(new Error('Timed out')), 20000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(new Error('Child failed')));
    child.stdin.on('error', () => finish(new Error('Child input failed')));
    child.stdout.on('data', chunk => {
      text += chunk.toString();
      if (Buffer.byteLength(text) > 32768) finish(new Error('Output too large'));
    });
    child.on('close', code => {
      try {
        if (code !== 0) throw new Error('Child failed');
        finish(null, JSON.parse(text));
      } catch { finish(new Error('Invalid child result')); }
    });
    child.stdin.end(JSON.stringify(input));
    if (signal?.aborted) abort();
  });
}

if (require.main === module) {
  (async () => {
    let text = '';
    for await (const chunk of process.stdin) {
      text += chunk.toString();
      if (Buffer.byteLength(text) > 8192) throw new Error('Input too large');
    }
    process.stdout.write(JSON.stringify(await execute(JSON.parse(text))));
  })().catch(() => { process.exitCode = 1; });
}
module.exports = { runPaid, execute };
