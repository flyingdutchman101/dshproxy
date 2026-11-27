import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { build } from '../index.js'
import { createForeplayTools } from '../lib/foreplay.js'
import {fileURLToPath} from 'node:url'
const host={bundleDir:fileURLToPath(new URL('../', import.meta.url)),execPath:process.execPath,versions:process.versions,platform:process.platform,env:{}}
test('Foreplay defaults off and explicit opt-in exposes both tools',()=>{
 assert.equal(build({},host).some(t=>t.name.startsWith('foreplay_')),false)
 assert.deepEqual(build({foreplayEnabled:true},host).filter(t=>t.name.startsWith('foreplay_')).map(t=>t.name),['foreplay_search','foreplay_boards'])
})

test('only exact fresh human selection dispatches a paid call',async()=>{
 let calls=0
 const call=async request=>{calls++;return {items:[],request}}
 for(const answer of [undefined,{answers:[]},{answers:[{id:'dshproxy-foreplay',selected:['Run once'],custom:'yes'}]}]) {
  const [tool]=createForeplayTools(call,{questions:()=>({ask:async()=>answer})})
  assert.equal((await tool.execute({query:'synthetic'}, {agent:{}})).outcome,'declined')
 }
 assert.equal(calls,0)
 const [tool]=createForeplayTools(call,{questions:()=>({ask:async()=>({answers:[{id:'dshproxy-foreplay',selected:['Run once']}]})})})
 await assert.rejects(tool.execute({query:'synthetic',approved:true},{agent:{}}))
 await assert.rejects(tool.execute({query:'synthetic'},{agent:{session:{header:{origin:'subagent'}}}}))
 assert.equal(calls,0)
 await tool.execute({query:'synthetic'},{agent:{}})
 assert.equal(calls,1)
})

test('approved search and boards cross the real child bridge to fixed CLI commands',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'foreplay-offline-'))
 fs.mkdirSync(path.join(root,'src/research'),{recursive:true})
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'dshproxy'}))
 fs.writeFileSync(path.join(root,'src/research/command.js'),`exports.run=async(args,out)=>out(JSON.stringify({args,items:[{id:'synthetic',label:'Offline fixture'}]}))`)
 const tools=build({root,foreplayEnabled:true},host,{questions:()=>({ask:async()=>({answers:[{id:'dshproxy-foreplay',selected:['Run once']}]})})})
 const search=await tools.find(t=>t.name==='foreplay_search').execute({query:'offline example'},{agent:{}})
 assert.deepEqual(search.args,['search','--query','offline example','--confirm-credits'])
 const boards=await tools.find(t=>t.name==='foreplay_boards').execute({},{agent:{}})
 assert.deepEqual(boards.args,['boards','--confirm-credits'])
})
