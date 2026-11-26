'use strict';
const {request}=require('./transport');
const FAILURE='ElevenLabs WebSocket failed or returned an invalid/oversized response. No retry was made; a submitted request may have been charged.';
// Fixed URLs only. Node's WHATWG WebSocket rejects redirect handshakes. Neither
// endpoint receives a permanent key: tokens are minted with redirect:error HTTPS.
async function stream({model,voice,text,audio},context={}) {
  const WS=context.WebSocketImpl || globalThis.WebSocket;
  if (typeof WS!=='function') throw new Error('Voice streaming requires Node 22 built-in WebSocket.');
  const live=model==='scribe_v3_live';
  const tokenResult=await request(`/v1/single-use-token/${live?'realtime_scribe?max_session_duration_seconds=120':'tts_websocket'}`,{body:'',json:true},context);
  if (typeof tokenResult?.token!=='string' || !/^[A-Za-z0-9_.~-]{1,4096}$/.test(tokenResult.token)) throw new Error(FAILURE);
  const url=new URL(live?'wss://api.elevenlabs.io/v1/speech-to-text/realtime':'wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input');
  url.searchParams.set('model_id',model);
  if(live) {
    url.searchParams.set('token',tokenResult.token);
    url.searchParams.set('audio_format','pcm_16000');
    url.searchParams.set('commit_strategy','manual');
    url.searchParams.set('include_timestamps','false');
  } else url.searchParams.set('output_format','mp3_44100_128');
  return new Promise((resolve,reject)=>{
    let ws, done=false, started=false, committed=false, offset=0, pump;
    let received=0, size=0, count=0; const chunks=[];
    const timer=setTimeout(()=>finish(),120000);
    function finish(result) {
      if(done) return; done=true;
      clearTimeout(timer); clearTimeout(pump);
      if(ws) { for(const [type,fn] of Object.entries(listeners)) ws.removeEventListener(type,fn); try { ws.close(); } catch {} }
      if(result) resolve(result); else reject(new Error(FAILURE));
    }
    function send(value) {
      if(ws.bufferedAmount>1024*1024) throw new Error();
      ws.send(JSON.stringify(value));
    }
    function feed() {
      if(done) return;
      try {
        const end=Math.min(offset+3200,audio.length);
        committed=end===audio.length;
        send({message_type:'input_audio_chunk',audio_base_64:audio.subarray(offset,end).toString('base64'),commit:committed,sample_rate:16000});
        offset=end;
        if(!committed) pump=setTimeout(feed,100);
      } catch { finish(); }
    }
    const listeners={
      open() { try {
        if(!live) {
          send({voices:[voice],single_use_token:tokenResult.token});
          send({inputs:[{text,voice_id:voice,new_turn:false}]});
          send({close_socket:true});
        }
      } catch { finish(); } },
      message(event) { if(done) return; try {
        // WHATWG delivers complete messages: caps apply immediately on delivery.
        if(typeof event.data!=='string' || event.data.length>8*1024*1024 || ++count>10000) throw new Error();
        received+=Buffer.byteLength(event.data);
        if(received>(live?4:75)*1024*1024) throw new Error();
        const msg=JSON.parse(event.data);
        if(!msg || typeof msg!=='object' || Array.isArray(msg) || Object.hasOwn(msg,'error')) throw new Error();
        if(live) {
          if(msg.message_type==='session_started' && !started) { started=true; feed(); }
          else if(msg.message_type==='warning' && typeof msg.warning==='string') { /* advisory only; never log provider text */ }
          else if(msg.message_type==='partial_transcript' && started && typeof msg.text==='string') { /* interim only */ }
          else if(msg.message_type==='committed_transcript' && committed && typeof msg.text==='string') {
            finish(Buffer.from(JSON.stringify({text:msg.text,model, audio_format:'pcm_16000'},null,2)+'\n'));
          } else throw new Error();
        } else {
          if(msg.audio!==undefined && msg.audio!==null && msg.audio!=='') {
            if(typeof msg.audio!=='string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(msg.audio)) throw new Error();
            const bytes=Buffer.from(msg.audio,'base64'); size+=bytes.length;
            if(size>50*1024*1024) throw new Error(); chunks.push(bytes);
          }
          if(msg.is_final===true) { if(!size) throw new Error(); finish(Buffer.concat(chunks)); }
        }
      } catch { finish(); } },
      error() { finish(); },
      close() { finish(); }
    };
    try { ws=new WS(url.toString()); for(const [type,fn] of Object.entries(listeners)) ws.addEventListener(type,fn); }
    catch { finish(); }
  });
}
module.exports={stream};
