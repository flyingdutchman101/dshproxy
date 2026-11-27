'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const voice = require('../src/provider-picker/voice');
const {models} = require('../src/video/picker/entries'); const {wired} = require('../src/video/picker');
test('enabled Flash voice is shown in the DSH profile and selected requests reach the voice handler', async t => {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'voice-profile-')); t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const id='eleven-flash-v2/tts/elevenlabs'; await voice.set(home,id,true);
 const entry=(await models(home)).find(m=>m.id===id); assert.equal(entry?.name,'Eleven Flash v2 - Text to speech - ElevenLabs');
 const gateway=wired({home,exposed:()=>false}); const body={model:id,messages:[{role:'user',content:'speak testvoice Hello world'}]};
 let answer='';await gateway.answer(body,s=>answer+=s);assert.match(answer,/Voice ID: testvoice/);assert.match(answer,/Quote Q-/);
 await voice.set(home,id,false);assert.ok(!(await models(home)).some(m=>m.id===id));answer='';await gateway.answer(body,s=>answer+=s);assert.match(answer,/disabled/);
});
