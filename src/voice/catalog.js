'use strict';
// Verified against https://elevenlabs.io/docs/overview/models.md and endpoint
// references on 2026-11-26. Availability is transport support, not account access.
const models = Object.freeze([
  {id:'eleven_v4', name:'Eleven v4', operation:'tts', supported:true, transport:'text-to-dialogue REST', maxCharacters:2000},
  {id:'eleven_v4_turbo', name:'Eleven v4 Turbo', operation:'tts', supported:true, transport:'text-to-dialogue WebSocket', maxCharacters:2000},
  {id:'eleven_flash_v2', name:'Eleven Flash v2', operation:'tts', supported:true, maxCharacters:40000},
  {id:'eleven_flash_v2_5', name:'Eleven Flash v2.5', operation:'tts', supported:true, maxCharacters:40000},
  {id:'scribe_v3', name:'Scribe v3', operation:'transcribe', supported:true},
  {id:'scribe_v3_live', name:'Scribe v3 Live', operation:'live', supported:true, transport:'speech-to-text WebSocket', input:'raw PCM16 LE mono 16000 Hz, 2–30 seconds'},
  {id:'scribe_v2_medical', name:'Scribe v2 Medical', operation:'transcribe', supported:true},
  {id:'eleven_multilingual_sts_v2', name:'Multilingual STS v2', operation:'change', supported:true}
].map(Object.freeze));
function select(id, operation) {
  const model = models.find(m => m.id === id);
  if (!model) throw new Error('Unknown voice model; use voice list.');
  if (!model.supported) throw new Error(model.reason);
  if (model.operation !== operation) throw new Error('Voice model does not support this operation.');
  return model;
}
module.exports = {models, select};
