'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {prepare, parseQuote} = require('../src/video/krea-preset');

const example = {mode:'preflight',compute_units:12,is_estimated:false,available_compute_units:400,affordable:true};
test('parses strict preflight numbers and booleans, omitting extraneous data', () => {
  assert.deepEqual(parseQuote({...example, provider_note:'private'}), example);
  const zero = {...example,compute_units:0,available_compute_units:0,is_estimated:true,affordable:false};
  assert.deepEqual(parseQuote(zero), zero);
  for (const name of Object.keys(example)) {
    const missing = {...example}; delete missing[name]; assert.throws(() => parseQuote(missing));
  }
  for (const k of ['compute_units','available_compute_units']) for (const v of [NaN,Infinity,-1,'12',null,false]) {
    assert.throws(() => parseQuote({...example,[k]:v}));
  }
  for (const k of ['is_estimated','affordable']) for (const v of [1,'true',null]) assert.throws(() => parseQuote({...example,[k]:v}));
  for (const bad of [null,[],{job_id:'j'},{...example,mode:'async'},Object.create(example),
    {...example,job:{id:'j'}},{...example,job_id:'j'},{...example,jobId:'j'},{...example,id:'j'},
    {...example,status:'queued'}, {...example,object:'video.job'}]) assert.throws(() => parseQuote(bad));
});

const pairs = [
  ['seedance-2.5', 'bytedance/seedance-2-5', '720p'],
  ['seedance-2.0', 'bytedance/seedance-2', '720p'],
  ['minimax-h3', 'minimax/hailuo-3', undefined],
  ['wan-3.0', 'alibaba/wan-3.0', '720p'],
];
const schema = resolution => ({type:'object', additionalProperties:false,
  properties:{prompt:{type:'string', minLength:1}, duration:{type:'integer', minimum:4, maximum:10},
    resolution:{type:'string', enum:[resolution]}, aspect_ratio:{type:'string', enum:['16:9','9:16']}},
  required:['duration'], anyOf:[{required:['prompt']},{required:['draft_job_id']}]});

test('fails closed for absent, incompatible or unsupported live restrictions', () => {
  const [model, id, res] = pairs[0];
  const reject = (change, prompt='Wave') => {
    const s = schema(res); change(s);
    assert.throws(() => prepare(model, prompt, [id], s), /schema|prompt/i);
  };
  for (const mutate of [s=>{delete s.properties.resolution;}, s=>{s.properties.resolution.enum=['1080p'];}, s=>{delete s.properties.resolution.enum;},
    s=>{s.properties.duration.type='string';}, s=>{s.properties.duration.maximum=4;},
    s=>{s.properties.duration.minimum=6;}, s=>{s.properties.duration.exclusiveMaximum=5;},
    s=>{s.properties.duration.enum=[4,6];}, s=>{s.properties.aspect_ratio.const='9:16';},
    s=>{s.properties.prompt.minLength=5;}, s=>{s.properties.prompt.maxLength=2;},
    s=>{s.properties.prompt.minLength='2';}, s=>{s.required=['start_image'];}]) reject(mutate);
  reject(()=>{}, '   ');
  const s = schema(res); s.properties.prompt.maxLength=1;
  assert.equal(prepare(model, '🌊', [id], s).input.prompt, '🌊'); // JSON Schema counts code points.
});

test('builds only exact discovered standard presets with a matching live input schema', () => {
  for (const [model, id, resolution] of pairs) {
    const live = schema(resolution); if (resolution === undefined) delete live.properties.resolution;
    assert.deepEqual(prepare(model, 'A wave', [id], live), {
      modelId:id, input:{prompt:'A wave', duration:5, aspect_ratio:'16:9', ...(resolution === undefined ? {} : {resolution})}});
    if (resolution !== undefined) {
      const ambiguous = schema(resolution); delete ambiguous.properties.resolution.enum;
      assert.throws(() => prepare(model, 'A wave', [id], ambiguous), /schema/);
    }
    for (const ids of [[id + '-fast'], id, null]) assert.throws(() => prepare(model, 'A wave', ids, schema(resolution)));
  }
});
