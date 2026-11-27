'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const settings=require('../src/video/settings');const picker=require('../src/video/picker/entries');
test('enabled model on a chosen billing route appears without a second switch; an explicit preset opt-out wins',async(t)=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'model-parity-')); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const model='kling-v3-standard', route='yotta'; const change=enabled=>settings.write(home,{models:{[model]:{enabled,route}}});
 const ids=async()=>(await picker.models(home)).map(m=>m.id); const id='kling-v3-standard/standard/yotta';
 assert.deepEqual(await ids(),[]);await change(true);assert.deepEqual(await ids(),[id]);
 const preset={model,resolution:'standard',route};await settings.setEntry(home,preset,false);assert.deepEqual(await ids(),[]);
 await settings.setEntry(home,preset,true);assert.deepEqual(await ids(),[id]);
 await settings.setEntry(home,preset,false);await change(false);assert.deepEqual(await ids(),[]);
});
