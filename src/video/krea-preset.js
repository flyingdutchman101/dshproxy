'use strict';
// Preparatory pure helpers only: no OAuth, MCP connection, generation or billing.
const presets = new Map([
  ['seedance-2.5', ['bytedance/seedance-2-5', '720p']],
  ['seedance-2.0', ['bytedance/seedance-2', '720p']],
  ['minimax-h3', ['minimax/hailuo-3', undefined]],
  ['wan-3.0', ['alibaba/wan-3.0', '720p']],
]);
const record = x => x !== null && typeof x === 'object' && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
function check(ok) { if (!ok) throw new Error('Live Krea input schema does not support the exact preset'); }
function keywords(schema, supported) {
  check(record(schema));
}
function requiredMatches(names, input) {
  check(Array.isArray(names) && names.every(n => typeof n === 'string') && new Set(names).size === names.length);
  return names.every(n => Object.hasOwn(input, n));
}
// This is a closed subset, not a general JSON Schema interpreter. Never infer a
// writable property from a default, example, permissive additionalProperties, or absent type.
function validateField(s, value) {
  const string = typeof value === 'string';
  const bounds = string ? ['minLength', 'maxLength'] : ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'];
  keywords(s, ['type', 'enum', 'const', ...bounds]);
  check(string ? s.type === 'string' : (s.type === 'number' && Number.isFinite(value)) || (s.type === 'integer' && Number.isInteger(value)));
  if (Object.hasOwn(s,'enum')) check(Array.isArray(s.enum) && s.enum.includes(value));
  if (Object.hasOwn(s,'const')) check(s.const === value);
  for (const k of bounds) if (Object.hasOwn(s, k)) {
    const n = s[k];
    if (string) {
      check(Number.isSafeInteger(n) && n >= 0);
      const length = [...value].length;
      check(k === 'minLength' ? length >= n : length <= n);
    } else {
      check(Number.isFinite(n));
      check(({minimum:value >= n, maximum:value <= n, exclusiveMinimum:value > n, exclusiveMaximum:value < n})[k]);
    }
  }
}
function validateSchema(s, input) {
  keywords(s, ['type','properties','required','additionalProperties','anyOf','$defs','definitions']);
  check(s.type === 'object' && record(s.properties));
  if (Object.hasOwn(s,'required')) check(requiredMatches(s.required, input));
  for (const [name, value] of Object.entries(input)) {
    check(Object.hasOwn(s.properties, name));
    validateField(s.properties[name], value);
  }
}
function modelId(model) { return presets.get(model)?.[0]; }
function prepare(model, prompt, discoveredIds, modelInputSchema, requestedResolution) {
  const preset = presets.get(model);
  if (!preset || !Array.isArray(discoveredIds) || !discoveredIds.includes(preset[0])) throw new Error('Exact Krea model not discovered');
  const [id, defaultResolution] = preset;
  check(requestedResolution === undefined || (defaultResolution && ['480p','720p','1080p'].includes(requestedResolution)));
  const resolution = requestedResolution ?? defaultResolution;
  const input = {prompt, duration:5, aspect_ratio:'16:9', ...(resolution === undefined ? {} : {resolution})};
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Krea prompt must not be empty');
  validateSchema(modelInputSchema, input);
  if (resolution !== undefined) {
    const field = modelInputSchema.properties.resolution;
    check(field.const === resolution || (Array.isArray(field.enum) && field.enum.includes(resolution)));
  }
  return {modelId:id, input};
}
function parseQuote(value) {
  const fields = ['mode','compute_units','is_estimated','available_compute_units','affordable'];
  const jobMarkers = ['job','jobs','job_id','jobId','id','status','object'];
  if (!record(value) || !fields.every(k => Object.hasOwn(value, k)) || jobMarkers.some(k => Object.hasOwn(value,k))
      || value.mode !== 'preflight' || ![value.compute_units,value.available_compute_units].every(v => Number.isFinite(v) && v >= 0)
      || typeof value.is_estimated !== 'boolean' || typeof value.affordable !== 'boolean') {
    throw new Error('Invalid Krea preflight quote');
  }
  return Object.fromEntries(fields.map(k => [k, value[k]]));
}
module.exports = { prepare, parseQuote, modelId };
