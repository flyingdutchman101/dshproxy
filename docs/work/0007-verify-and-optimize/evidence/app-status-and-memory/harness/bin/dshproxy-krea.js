'use strict';
// Stand-in for bin\dshproxy-krea.js in a seam check. Contacts nothing, stores nothing but a flag file.
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.FAKE_KREA_MODE || '';
const flag = process.env.FAKE_KREA_FLAG;
fs.appendFileSync(process.env.FAKE_KREA_LOG, JSON.stringify({ pid: process.pid, args, cwd: process.cwd(), node: process.execPath }) + '\n');
if (args.length === 1 && args[0] === 'status') {
  process.stdout.write((mode.startsWith('status:') ? mode.slice(7) : JSON.stringify(fs.existsSync(flag) ? { signedIn: true, expiresAt: Date.now() + 3600000 } : { signedIn: false })) + '\n');
} else if (args.length === 1 && args[0] === 'logout') {
  fs.rmSync(flag, { force: true });
} else if (args.length === 1 && args[0] === 'login') {
  const plan = JSON.parse(mode);
  if (plan.address) process.stdout.write(plan.address + '\n');
  setTimeout(() => {
    if (plan.exit === 'ok') { fs.writeFileSync(flag, ''); return; }
    process.stderr.write(plan.exit + '\n');
    process.exitCode = 1;
  }, plan.waitMs);
} else {
  process.stderr.write('KREA_REFUSED\n');
  process.exitCode = 1;
}
