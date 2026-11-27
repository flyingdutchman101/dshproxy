'use strict';
const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path');
const entries=require('../src/video/picker/entries');
test('dedicated opt in offers stable Foreplay entry',async()=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),'fp-picker-')); assert.equal((await entries.models(home)).some(x=>x.id==='ad-research/foreplay'),false); fs.writeFileSync(path.join(home,'provider-picker.json'),JSON.stringify({foreplay:true})); assert.deepEqual((await entries.models(home)).find(x=>x.id==='ad-research/foreplay')?.name,'Ad research – Foreplay');});
