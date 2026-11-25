const {execFile} = require('node:child_process');
const exec = require('node:util').promisify(execFile);
const repo = 'flyingdutchman101/dshproxy';
const shaRE = /^[a-f0-9]{40}$/;
const manual = `https://github.com/${repo}#readme`;
async function get(route) {
  const response = await fetch(`https://api.github.com/repos/${repo}/${route}`, {redirect:'error', signal:AbortSignal.timeout(8000), headers:{Accept:'application/vnd.github+json','User-Agent':'DSHProxy-updater'}});
  if (!response.ok) throw Error(`GitHub update check returned HTTP ${response.status}. Try again later.`);
  return response.json();
}
async function select(installed, request = get) {
  if (!shaRE.test(installed)) throw Error('Cannot identify the installed Git revision.');
  let cursor = 'main';
  // Stop at the installed revision, root, or deadline; never interpret a timeout
  // or API-rate limit as proof that a revision is safe to install.
  const until = Date.now()+90000;
  while (Date.now()<until) {
    const commit = await request(`commits/${cursor}`);
    const candidate = commit.sha;
    if (!shaRE.test(candidate) || (cursor !== 'main' && cursor !== candidate)) throw Error('Unexpected GitHub commit response.');
    if (candidate === installed) return {status:'current',installed,message:'No newer passing update is available.'};
    const runs = await request(`actions/workflows/ci.yml/runs?head_sha=${candidate}&branch=main&event=push&per_page=1`);
    const run = runs.workflow_runs[0];
    if (run?.head_sha === candidate && run.event === 'push' && run.head_branch === 'main' && run.head_repository?.full_name === repo && run.status === 'completed' && run.conclusion === 'success') {
      const comparison=await request(`compare/${installed}...${candidate}?per_page=1`);
      if (comparison.status!=='ahead') return {status:'unavailable',installed,message:`No fast-forward update for this checkout. For manual installation see ${manual}`};
      return {status:'available',installed,candidate,subject:String(commit.commit.message).split('\n')[0].replace(/[\x00-\x1f\x7f]/g,' ').slice(0,240),url:`https://github.com/${repo}/commit/${candidate}`,message:'A CI-verified DSHProxy update is available.'};
    }
    cursor=commit.parents?.[0]?.sha;
    if (!shaRE.test(cursor)) break;
  }
  return {status:'unavailable',installed,message:'No verified update found in recent main history. Check again later.'};
}
async function check({root}) {
  let installed;
  try {
    installed=(await exec('git',['-C',root,'rev-parse','--verify','HEAD'],{windowsHide:true,timeout:5000})).stdout.trim();
  } catch {return {status:'unavailable',message:`Updates require a Git checkout and Git on PATH. See ${manual}`};}
  return select(installed);
}
module.exports={select,check};
