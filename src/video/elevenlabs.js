'use strict';
// Verified 2026-11-26 against https://api.elevenlabs.io/openapi.json
// Only the seven public VideoGenerationRequest discriminator members.
const definitions = [
  ['seedance-2.0', 'Seedance 2.0', 'bytedance-seedance-v2', ['480p','720p','1080p','4k'], 15],
  ['seedance-2.0-fast', 'Seedance 2.0 Fast', 'bytedance-seedance-v2-fast', ['480p','720p'], 15],
  ['seedance-2.0-mini', 'Seedance 2.0 Mini', 'bytedance-seedance-v2-mini', ['480p','720p'], 15],
  ['seedance-2.5', 'Seedance 2.5', 'bytedance-seedance-v2.5', ['480p','720p','1080p','4k'], 30],
  ['veo-3.1', 'Veo 3.1', 'veo-3.1-generate-001', ['720p','1080p','4K']],
  ['veo-3.1-fast', 'Veo 3.1 Fast', 'veo-3.1-fast-generate-001', ['720p','1080p','4K']],
  ['aurora', 'Aurora', 'creatify-aurora', ['480p','720p']],
];
function rows() {
  return definitions.map(([model,name,modelId,resolutions,max]) => ({model,name, resolutions: Object.fromEntries(resolutions.map(resolution => [resolution, {
    modelId, verifiedOn:'2026-11-26', sourceUrls:['https://api.elevenlabs.io/openapi.json'], priceBasis:'unavailable',
    durationSeconds:model === 'aurora' ? null : max ? 5 : 8,
    supportedDurations:model === 'aurora' ? [] : max ? Array.from({length:max-3}, (_,i)=>i+4) : [4,6,8],
    inputMode:model === 'aurora' ? 'image-audio' : 'text',
    requiresProviderApproval:Boolean(max),
  }]))}));
}
function duration(entry, value) {
  const seconds = value === undefined ? entry.durationSeconds : value;
  if (entry.inputMode === 'image-audio') {
    if (value !== undefined) throw new Error('Aurora duration is determined by its audio input.');
    return null;
  }
  if (!entry.supportedDurations.includes(seconds)) throw new Error('Unsupported ElevenLabs duration for this model.');
  return seconds;
}
function body(entry, {prompt, durationSeconds, image, audio}) {
  if (entry.inputMode === 'image-audio') {
    const asset = value => value && value.type === 'asset' && typeof value.asset_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.asset_id) && Object.keys(value).length === 2;
    if (!asset(image) || !asset(audio) || prompt !== undefined || durationSeconds !== undefined) throw new Error('Aurora requires image and audio asset references, not a text prompt or duration.');
    return {model_id:entry.modelId, resolution:entry.resolution, image, audio};
  }
  if (image !== undefined || audio !== undefined || typeof prompt !== 'string' || !prompt.trim()) throw new Error('Invalid ElevenLabs text video inputs.');
  return {model_id:entry.modelId, prompt, resolution:entry.resolution, duration_secs:duration(entry,durationSeconds), aspect_ratio:'16:9', generate_audio:true};
}
module.exports = {rows, duration, body};
