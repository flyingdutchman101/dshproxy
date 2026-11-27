'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const voice=require('../src/provider-picker/voice');
const model='eleven-flash-v2/tts/elevenlabs';
test('human quote, exact confirmation, private MP3 and durable replay protection',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'voice-test-'));await voice.set(home,model,true);assert.equal(voice.entries(home)[0].id,model);
 let calls=0;const create=()=>voice.create({home,exposed:()=>false,generate:async()=>{calls++;return Buffer.from('ID3synthetic');}});let answer;const write=s=>{answer=s;};const messages=[{role:'user',content:'speak Voice123 Hello world'}];await create().answer({model,messages},write);assert.match(answer,/not a price cap/);const quote=answer;messages.push({role:'assistant',content:quote},{role:'user',content:'yes'});await create().answer({model,messages},write);assert.match(answer,/Download MP3/);assert.equal(calls,1);const url=answer.match(/<(.*?)>/)[1];assert.equal(fs.readFileSync(new URL(url),'utf8'),'ID3synthetic');
 if(process.platform==='win32') {
   const target=require('node:url').fileURLToPath(url);
   const inspect="$a=Get-Acl -LiteralPath $env:VOICE_TEST_OUTPUT; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); if (!$a.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid -or $rules[0].AccessControlType -ne 'Allow') {exit 1}";
   require('node:child_process').execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',inspect],{env:{...process.env,VOICE_TEST_OUTPUT:target}});
 } else assert.equal(fs.statSync(new URL(url)).mode&0o777,0o600);
 await create().answer({model,messages},write);assert.equal(calls,1);assert.match(answer,/already used/);
});
test('automation, refusal, disable, expiry and altered quote never spend',async()=>{
 for(const scenario of ['automation','refusal','disable','expiry','altered']){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'voice-test-'));await voice.set(home,model,true);let calls=0,time=0,answer;const picker=voice.create({home,exposed:()=>false,now:()=>time,generate:async()=>{calls++;return Buffer.from('ID3');}});const write=s=>{answer=s;};const messages=[{role:'user',content:'speak Voice123 Hello'}];await picker.answer({model,messages},write);messages.push({role:'assistant',content:answer},{role:'user',content:'yes'});
 if(scenario==='automation')messages.at(-1).content='<goal_round> yes';
 if(scenario==='refusal'){messages.at(-1).content='no';await picker.answer({model,messages},write);messages.at(-1).content='yes';}
 if(scenario==='disable')await voice.set(home,model,false);
 if(scenario==='expiry')time=300000;
 if(scenario==='altered')messages[1].content=messages[1].content.replace('Hello','Goodbye');
 await picker.answer({model,messages},write);assert.equal(calls,0,scenario);
 }
});

test('quote metadata never retains speech and exact whitespace changes cannot spend',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'voice-test-'));await voice.set(home,model,true);let answer,calls=0;const picker=voice.create({home,exposed:()=>false,generate:async()=>{calls++;return Buffer.from('ID3');}});const messages=[{role:'user',content:'speak Voice123 Private sentence'}];await picker.answer({model,messages},s=>answer=s);const files=fs.readdirSync(path.join(home,'voice-picker')).filter(n=>n!== 'enabled.json'&&n.endsWith('.json'));const saved=JSON.parse(fs.readFileSync(path.join(home,'voice-picker',files[0]),'utf8'));assert.deepEqual(Object.keys(saved).sort(),['digest','entryId','expires']);assert.match(saved.digest,/^[a-f0-9]{64}$/);messages.push({role:'assistant',content:answer+' '},{role:'user',content:'yes'});await picker.answer({model,messages},s=>answer=s);assert.equal(calls,0);
});

test('altered refusal cannot claim original; concurrent confirmation reserves one output',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'voice-test-'));await voice.set(home,model,true);let answer,calls=0;const folder=path.join(home,'voice-picker');const picker=voice.create({home,exposed:()=>false,generate:async input=>{calls++;assert.equal(input.text,'Hello');assert.equal(fs.readdirSync(folder).filter(n=>n.endsWith('.mp3')).length,1);return Buffer.from('ID3');}});const messages=[{role:'user',content:'speak Voice123 Hello'}];await picker.answer({model,messages},s=>answer=s);const quote=answer;await picker.answer({model,messages:[...messages,{role:'assistant',content:quote.replace('Hello','Altered')},{role:'user',content:'no'}]},s=>answer=s);messages.push({role:'assistant',content:quote},{role:'user',content:'yes'});await Promise.all([picker.answer({model,messages},()=>{}),picker.answer({model,messages},()=>{})]);assert.equal(calls,1);
});
test('generation failure removes reserved output without releasing claim',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'voice-test-'));await voice.set(home,model,true);let answer,calls=0;const picker=voice.create({home,exposed:()=>false,generate:async()=>{calls++;throw Error('fixture');}});const messages=[{role:'user',content:'speak Voice123 Hello'}];await picker.answer({model,messages},s=>answer=s);messages.push({role:'assistant',content:answer},{role:'user',content:'yes'});await picker.answer({model,messages},s=>answer=s);assert.equal(fs.readdirSync(path.join(home,'voice-picker')).filter(n=>n.endsWith('.mp3')).length,0);await picker.answer({model,messages},()=>{});assert.equal(calls,1);
});

for (const phase of ['startup', 'child-provider', 'delayed-provider']) test(`abort during ${phase} cleans output and retains claim`, async t => {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'voice-abort-'));
 await voice.set(home,model,true);
 const controller=new AbortController(); let calls=0, answer, release;
 const ready=new Promise(resolve=>release=resolve);
 let complete;
 const pending=new Promise(resolve=>complete=resolve);
 const childProcess=require('node:child_process');
 const {EventEmitter}=require('node:events');
 let killed=false, sent=0;
 if(phase!=='delayed-provider') t.mock.method(childProcess,'fork',()=>{
   const child=new EventEmitter();
   child.send=()=>{sent++;release();pending.then(()=>{child.emit('message',{audio:Buffer.from('ID3').toString('base64')});child.emit('exit',0);});};
   child.kill=()=>{killed=true;queueMicrotask(()=>child.emit('exit',null));};
   if(phase==='startup'){controller.abort();release();}
   else queueMicrotask(()=>child.emit('message',{ready:true}));
   return child;
 });
 const picker=voice.create({home,exposed:()=>false,...(phase==='delayed-provider'?{generate:async()=>{calls++;release();await pending;return Buffer.from('ID3');}}:{})});
 const messages=[{role:'user',content:'speak Voice123 Hello'}];
 await picker.answer({model,messages},s=>answer=s);
 messages.push({role:'assistant',content:answer},{role:'user',content:'yes'});
 const result=picker.answer({model,messages},s=>answer=s,{signal:controller.signal});
 await ready; controller.abort(); complete();
 await result;
 assert.doesNotMatch(answer,/Download MP3/);
 assert.match(answer,/may have been charged/);
 assert.equal(fs.readdirSync(path.join(home,'voice-picker')).filter(n=>n.endsWith('.mp3')).length,0);
 assert.equal(fs.readdirSync(path.join(home,'voice-picker')).filter(n=>n.endsWith('.claimed')).length,1);
 if(phase!=='delayed-provider'){assert.equal(killed,true);assert.equal(sent,phase==='startup'?0:1);}
 await picker.answer({model,messages},s=>answer=s);
 assert.match(answer,/already used/);
 assert.equal(calls,phase==='delayed-provider'?1:0);
});
