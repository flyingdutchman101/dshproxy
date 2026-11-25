const path = require('node:path');
const SHA = /^[a-f0-9]{40}$/;
async function run(args, out) {
  const root = path.resolve(__dirname, '../..');
  let reply;
  try {
    if (args.length === 1 && args[0] === 'result') reply = await require('./result').desktopResult({root});
    else if (args.length === 1 && args[0] === 'check') reply = await require('./candidate').check({root});
    else if ((args.length === 3 || (args.length === 4 && ['--owns-gateway','--no-gateway'].includes(args[3]))) && args[0] === 'install' && args[1] === '--sha' && SHA.test(args[2])) {
      const selected = await require('./candidate').check({root});
      reply = selected.status === 'available' && selected.candidate === args[2]
        ? await require('./install').startInstall({root,sha:args[2],guiPid:process.ppid, ownsGateway:args[3]==='--owns-gateway'})
        : {status:'unavailable',message:selected.status === 'unavailable' ? selected.message : 'The checked update changed or is no longer eligible. Check again.'};
    } else reply = {status:'unavailable',message:'Use check, result, or install --sha with the exact 40-character checked revision.'};
  } catch (error) { reply = {status:'unavailable',message:error.message}; }
  out(JSON.stringify(reply));
}
module.exports = {run};
