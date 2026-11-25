const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const exec = require('node:util').promisify(execFile);
const {setTimeout:delay}=require('node:timers/promises');
const {readResult}=require('./install');

// Invoked from the native app after its UI is initialized. A fresh random
// per-launch challenge prevents an earlier GUI's result from satisfying verify.
async function desktopResult({root,session=process.env.DSHPROXY_UPDATE_SESSION}) {
  if (!session || !/^[a-zA-Z0-9-]{16,100}$/.test(session)) return {status:'none',message:''};
  const head=(await exec('git',['-C',root,'rev-parse','HEAD'],{windowsHide:true,timeout:5000})).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw Error('Cannot verify checkout on relaunch.');
  await fs.writeFile(path.join(root,'.git',`dshproxy-ready-${session}`),head,{flag:'wx',mode:0o600});
  for(let i=0;i<160;i++) {
    const state=await readResult({root});
    if(state.status!=='started' && state.status!=='unavailable') return {status:state.status==='succeeded'?'success':'failed',message:state.message};
    await delay(250);
  }
  return {status:'working',message:'The update worker has not yet reported a final result.'};
}
module.exports={desktopResult};
