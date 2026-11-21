'use strict';
// Preparatory pure helpers only: no OAuth, MCP connection, generation or billing.
const presets = new Map([
  ['seedance-2.5', ['video/bytedance/seedance-2-5', '720p']],
  ['seedance-2.0', ['video/bytedance/seedance-2', '720p']],
  ['minimax-h3', ['video/minimax/hailuo-3', '768p']],
  ['wan-3.0', ['video/alibaba/wan-3.0', '720p']],
]);
const record = x => x !== null && typeof x === 'object' && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const annotations = ['title', 'description', 'default', 'examples', 'example', '$comment'];
function check(ok) { if (!ok) throw new Error('Live Krea input schema does not support the exact preset'); }
function keywords(schema, supported) {
  check(record(schema) && Object.keys(schema).every(k => annotations.includes(k) || supported.includes(k)));
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
  if (Object.hasOwn(s,'additionalProperties')) check(typeof s.additionalProperties === 'boolean');
  if (Object.hasOwn(s,'required')) check(requiredMatches(s.required, input));
  if (Object.hasOwn(s,'anyOf')) {
    check(Array.isArray(s.anyOf) && s.anyOf.length > 0);
    const matches = s.anyOf.map(branch => {
      keywords(branch, ['required']);
      return requiredMatches(branch.required, input);
    });
    check(matches.includes(true));
  }
  for (const [name, value] of Object.entries(input)) {
    check(Object.hasOwn(s.properties, name));
    validateField(s.properties[name], value);
  }
}
function prepare(model, prompt, discoveredIds, modelInputSchema) {
  const preset = presets.get(model);
  if (!preset || !Array.isArray(discoveredIds) || !discoveredIds.includes(preset[0])) throw new Error('Exact Krea model not discovered');
  const [modelId, resolution] = preset;
  const input = {prompt, duration:5, resolution, aspect_ratio:'16:9'};
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Krea prompt must not be empty');
  validateSchema(modelInputSchema, input);
  const field = modelInputSchema.properties.resolution;
  check(field.const === resolution || (Array.isArray(field.enum) && field.enum.includes(resolution)));
  return {modelId, input};
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
module.exports = { prepare, parseQuote };
