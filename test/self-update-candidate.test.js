const test = require('node:test');
const assert = require('node:assert/strict');
const {select} = require('../src/self-update/candidate');
const a='a'.repeat(40), b='b'.repeat(40), c='c'.repeat(40), repo='flyingdutchman101/dshproxy';
function api(tipRun, relation='ahead') {
  return async route => {
    const commit=(sha,parent)=>({sha,parents:[{sha:parent}],commit:{message:'An update\n\nDetails'}});
    if(route==='commits/main') return commit(c,b);
    if(route==='commits/'+b) return commit(b,a);
    if(route.startsWith('compare/')) return {status:relation};
    const sha=new URLSearchParams(route.split('?')[1]).get('head_sha');
    assert.ok([b,c].includes(sha));
    const run={event:'push',status:'completed',conclusion:'success',head_branch:'main',head_sha:sha,head_repository:{full_name:repo}};
    return {workflow_runs:[sha===c?{...run,...tipRun}:run]};
  };
}
test('walk first parents past ineligible main builds rather than installing them',async()=>{
  for(const invalid of [{event:'pull_request'},{conclusion:'failure'},{status:'queued'},{head_branch:'other'},{head_sha:a},{head_repository:{full_name:'fork/dshproxy'}}]){
    const result=await select(a,api(invalid));
    assert.equal(result.status,'available'); assert.equal(result.candidate,b);
    assert.equal(result.subject,'An update'); assert.equal(result.url,`https://github.com/${repo}/commit/${b}`);
  }
});
test('do not offer downgrades or replace divergent local history',async()=>{
  assert.equal((await select(c,api({}))).status,'current');
  for(const relation of ['behind','diverged']) assert.notEqual((await select(a,api({},relation))).status,'available');
});
