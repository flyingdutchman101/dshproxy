'use strict';
const { createHost } = require('./desktop-host');
const { runInstall } = require('./install-worker');

async function main(plan) {
  const host = createHost({ platform: plan.platform, guiPid: plan.guiPid });
  const fs = require('node:fs/promises');
  const path = require('node:path');
  let released = false;
  const reply = async value => {
    await fs.writeFile(path.join(plan.mailbox,'pending'), JSON.stringify(value), {flag:'wx',mode:0o600});
    await fs.rename(path.join(plan.mailbox,'pending'),path.join(plan.mailbox,'reply'));
    released = true;
  };
  const quit = host.quit;
  host.quit = async p => {
    await reply({status:'started',message:'Build verified; the gateway is idle. Relaunching DSHProxy.'});
    return quit(p);
  };
  const result = await runInstall(plan, host);
  if (!released) await reply({status:'unavailable',message:result.message});
  return result;
}
if (require.main === module) {
  Promise.resolve().then(() => main(JSON.parse(process.argv[2]))).catch(() => {
    // runInstall persists actionable, redacted results. Do not leak subprocess
    // output or environment through a detached worker's error handling.
    process.exitCode = 1;
  });
}
module.exports = { main };
