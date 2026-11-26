'use strict';
const {models, select} = require('./catalog');
const {request} = require('./transport');
const {stream} = require('./websocket');
const {readInput, reserveOutput, MAX_AUDIO} = require('./io');
const help = `dshproxy voice list
  voice voices [--search TEXT] [--page-token TOKEN]  List one page of account voices
  voice pick VOICE_ID                              Look up a voice (does not save a default)
  voice tts MODEL --voice ID --text-file PATH --output PATH --confirm-charge
  voice transcribe MODEL --input PATH --output PATH --confirm-charge
  voice change MODEL --voice ID --input PATH --output PATH --confirm-charge
Models use exact IDs from voice list. Outputs must not exist; audio output is MP3.
Input audio limit: 25 MiB. Text: UTF-8; v4 limited to 2,000 characters for reliable dialogue.
  voice live scribe_v3_live --input PCM_PATH --output JSON_PATH --confirm-charge
Live input: raw signed PCM16 little-endian, mono 16kHz, 2–30 seconds (no WAV header).
Turbo and Live use Node 22 WebSocket and short-lived single-use tokens. No microphone.
Keys: ELEVENLABS_API_KEY or video key set elevenlabs (stdin, encrypted storage).
--confirm-charge authorizes a paid request, not a price cap. No automatic retries.
Files/text are sent to ElevenLabs. Provider retention defaults apply; medical use
requires appropriate agreements (including a BAA for PHI). No compliance guarantee.`;
function options(args, allowed) {
  const result = Object.create(null);
  for (let i=0;i<args.length;i++) {
    const key=args[i];
    if (!allowed.includes(key) || Object.hasOwn(result,key)) throw new Error('Unknown or repeated voice option; use voice help.');
    if (key==='--confirm-charge') result[key]=true;
    else {
      const value=args[++i];
      if (typeof value!=='string' || !value || value.startsWith('--') || value.length>4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid voice option value.');
      result[key]=value;
    }
  }
  return result;
}
function voiceId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid voice ID.');
  return id;
}
async function run(args, out, context={}) {
  const emit = value=>out(JSON.stringify(value,null,2));
  if (!args.length || (args.length===1 && ['help','--help','-h'].includes(args[0]))) return out(help);
  const [action, model] = args;
  if (action==='list' && args.length===1) return emit({models});
  if (action==='voices' || action==='pick') {
    const query=new URLSearchParams({page_size:'100'});
    if (action==='pick') {
      if (args.length!==2) throw new Error('Use voice pick VOICE_ID.');
      query.set('voice_ids',voiceId(model));
    } else {
      const opt=options(args.slice(1), ['--search','--page-token']);
      if (opt['--search']) query.set('search',opt['--search']);
      if (opt['--page-token']) query.set('next_page_token',opt['--page-token']);
    }
    const data=await request(`/v2/voices?${query}`,{json:true},context);
    if (!data || !Array.isArray(data.voices) || typeof data.has_more!=='boolean' || (data.has_more && typeof data.next_page_token!=='string')) throw new Error('Invalid voice list response.');
    const voices=data.voices.map(v=>({voice_id:voiceId(v.voice_id),name:typeof v.name==='string'?v.name:'',category:typeof v.category==='string'?v.category:''}));
    if (action==='pick') {
      const chosen=voices.find(v=>v.voice_id===model);
      if (!chosen) throw new Error('Voice was not returned by this account.');
      return emit({voice:chosen});
    }
    return emit({voices,has_more:data.has_more,next_page_token:typeof data.next_page_token==='string'?data.next_page_token:null});
  }
  if (!['tts','transcribe','change','live'].includes(action)) throw new Error('Unknown voice command; use voice help.');
  const entry=select(model,action);
  const allowed=['--output','--confirm-charge', ...(action==='tts'?['--text-file','--voice']:action==='change'?['--input','--voice']:['--input'])];
  const opt=options(args.slice(2),allowed);
  if (!opt['--confirm-charge']) throw new Error('Paid voice operations require --confirm-charge. No request sent.');
  if (!opt['--output'] || !opt[action==='tts'?'--text-file':'--input']) throw new Error('Input and output paths are required.');
  const voice=['transcribe','live'].includes(action)?null:voiceId(opt['--voice']);
  let body, route, streamInput;
  if (action==='tts') {
    const bytes=await readInput(opt['--text-file'],160000);
    let text;
    try { text=new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { throw new Error('Text input must be UTF-8.'); }
    if (!text.trim() || [...text].length>entry.maxCharacters) throw new Error('Text exceeds the model character limit or is empty.');
    if(model==='eleven_v4_turbo') streamInput={model,voice,text};
    body=JSON.stringify(model==='eleven_v4'?{model_id:model,inputs:[{text,voice_id:voice}]}:{model_id:model,text});
    route=model==='eleven_v4'?'/v1/text-to-dialogue':`/v1/text-to-speech/${voice}`;
  } else if(action==='live') {
    const audio=await readInput(opt['--input'],960000);
    if(audio.length<64000 || audio.length%2 || audio.subarray(0,4).toString()==='RIFF') throw new Error('Live input must be raw PCM16 LE mono 16kHz, 2–30 seconds, without a WAV header.');
    streamInput={model,audio};
  } else {
    const bytes=await readInput(opt['--input'],MAX_AUDIO);
    body=new FormData();
    body.set('model_id',model);
    body.set(action==='change'?'audio':'file',new Blob([bytes],{type:'application/octet-stream'}),'input.audio');
    route=action==='change'?`/v1/voice-changer/${voice}`:'/v1/speech-to-text';
  }
  if (!streamInput && action!=='transcribe') route+='?output_format=mp3_44100_128';
  const output=await reserveOutput(opt['--output']);
  try {
    let data=streamInput ? await stream(streamInput,context) : await request(route,{body,json:action==='transcribe'},context);
    if (action==='transcribe') {
      if (!data || typeof data.text!=='string' || typeof data.language_code!=='string' || !Array.isArray(data.words)) throw new Error('Invalid transcript response.');
      data=Buffer.from(JSON.stringify(data,null,2)+'\n');
    }
    await output.save(data);
    emit({saved:true,model,operation:action,bytes:data.length});
  } finally { await output.close(); }
}
module.exports = {run, help};
