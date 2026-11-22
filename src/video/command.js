const { quote, models } = require('./catalog');

const help = `dshproxy video list
  video settings                         List enabled models and billing routes
  video settings set MODEL ROUTE enabled|disabled
  video quote MODEL [ROUTE]              Show a dated API-route estimate (USD or plan credits)
  video krea MODEL                       Prepare a manual quote-only handoff (offline)
  video quote MODEL krea --prompt "PROMPT"  Preflight in signed-in workspace units
  video submit MODEL krea --max-units COUNT --confirm-charge "PROMPT"
  video submit MODEL ROUTE --max-usd AMOUNT --confirm-charge "PROMPT"
  video submit minimax-h3 callirra --max-credits COUNT --confirm-charge "PROMPT"
  video status MODEL ROUTE JOB_ID        Check once, never resubmit
  video key list                         Show which provider keys are saved or set (never a key)
  video key set PROVIDER                 Save or replace a provider key, read from standard input
  video key remove PROVIDER              Remove a saved provider key
API routes: videorouter, videorouter-replicate (Wan only), kovapi, callirra (H3 only). Workspace route: krea.
Five seconds, 16:9, text only. Caps check the API estimate or workspace preflight, not the final bill.
Credentials: a key saved with video key set (providers videorouter, kovapi, callirra), stored encrypted like the chat API keys,
or VIDEOROUTER_API_KEY, KOVAPI_API_KEY or CALLIRRA_API_KEY, which wins when set. Never pass keys on the command line.
Video settings control what an integration offers, not what the direct video CLI can submit or a spending limit.`;


function budgetMicros(value) {
  if (!/^\d{1,6}(?:\.\d{1,6})?$/.test(value)) throw new Error('Invalid USD budget: use a positive decimal, up to six decimal places.');
  const [dollars, cents=''] = value.split('.');
  return Number(dollars) * 1000000 + Number(cents.padEnd(6, '0'));
}

// `readSecret(prompt)` gives the text of standard input for `key set`; only
// the program that owns standard input can provide it. `loadMasterKey` stands
// in for the Windows-protected master key of src/secrets.js.
async function run(args, out, {env=process.env, fetchImpl=globalThis.fetch, workspace, readSecret, loadMasterKey}={}) {
  const [action, model, route] = args;
  const emit = (data) => out(JSON.stringify(data, null, 2));
  if (!args.length || (args.length === 1 && ['help','--help','-h'].includes(action))) return out(help);
  if (action === 'list' && args.length === 1) return emit(models);
  if (action === 'settings') {
    const settings = require('./settings');
    const {routesFor} = require('./catalog');
    const home = env.DSHPROXY_HOME || undefined;
    let current;
    if (args.length === 1) current = await settings.read(home);
    else if (args.length === 5 && model === 'set' && ['enabled','disabled'].includes(args[4])) {
      if (args[3] === 'none' && args[4] !== 'disabled') throw new Error('Choose a billing route before enabling a video model.');
      current = await settings.write(home, {models:{[route]:{route:args[3] === 'none' ? null : args[3],enabled:args[4] === 'enabled'}}});
    } else throw new Error('Use video settings, or video settings set MODEL ROUTE enabled|disabled.');
    return emit({models:models.map(name=>({model:name,...current.models[name],routes:routesFor(name)}))});
  }
  if (action === 'key') {
    const keys = require('./keys');
    const usage = `Use video key list, video key set PROVIDER (the key is read from standard input, never from the command line), or video key remove PROVIDER. Providers: ${keys.providers.join(', ')}.`;
    const home = env.DSHPROXY_HOME || undefined;
    // model and route hold the subcommand and the provider here. Neither is
    // repeated in a message: a key typed in the wrong place must not be echoed.
    if (model === 'list' && args.length === 2) return emit({providers:await keys.list(home, {env, loadMasterKey})});
    if (!['set','remove'].includes(model) || args.length !== 3) throw new Error(usage);
    if (!keys.providers.includes(route)) throw new Error(`Unknown video key provider. ${usage}`);
    if (model === 'remove') return emit(await keys.remove(home, route));
    const secret = typeof readSecret === 'function' ? await readSecret(`API key for ${route}: `) : '';
    if (typeof secret !== 'string' || !secret.trim()) throw new Error(`No key was given on standard input. ${usage}`);
    return emit(await keys.set(home, route, secret, {loadMasterKey}));
  }
  if (route === 'krea' && ['quote','submit','status'].includes(action)) {
    if (!models.includes(model)) throw new Error('Unknown video model');
    const client = require('./workspace');
    const req = client.request(args);
    return emit(client.result(req, await (workspace || client.invoke)(req)));
  }
  if (action === 'quote' && [2,3].includes(args.length)) {
    const q = quote(model, route);
    const estimatedUsd = q.usdMicros / 1000000;
    const billing = q.priceBasis === 'effective'
      ? {currency:'credits', amount:q.credits, budgetFlag:'--max-credits'}
      : {currency:'USD', amount:estimatedUsd, budgetFlag:'--max-usd'};
    return emit({...q, ...billing, estimatedUsd});
  }
  if (action === 'krea' && args.length === 2) {
    const {resolution} = quote(model);
    return emit({provider:'krea', mode:'external-oauth-handoff', contacted:false, server:'https://api.krea.ai/mcp',
      instructions:`Use Krea workspace OAuth (not an API token). Inspect the standard ${model} model schema. Only if it supports exactly 5s, ${resolution}, 16:9 text-to-video without references, call generate with preflight: true. Return mode ('preflight'), compute_units, is_estimated, available_compute_units and affordable. If the exact preset or preflight is unavailable, stop. Do not submit a job.`,
      source:'https://www.krea.ai/docs/developers/mcp.md'});
  }
  if (action !== 'submit' && action !== 'status') throw new Error(help);
  if (!model || !route) throw new Error('Specify both model and route.');
  const q = quote(model, route);
  const submitting = action === 'submit';
  if (submitting) {
    const creditPlan = q.priceBasis === 'effective';
    if (args.length !== 7 || args[3] !== (creditPlan ? '--max-credits' : '--max-usd') || args[5] !== '--confirm-charge' || !args[6].trim() || args[6].startsWith('--')) throw new Error(help);
    if (creditPlan) {
      if (!/^\d{1,6}$/.test(args[4]) || Number(args[4]) < q.credits) throw new Error('Insufficient credit budget; no job submitted.');
    } else if (budgetMicros(args[4]) < q.usdMicros) throw new Error('The quote exceeds --max-usd; no job submitted.');
  } else if (args.length !== 4) throw new Error(help);
  // The provider's environment variable when set, otherwise the saved key;
  // with neither, or a saved key that cannot be read, this throws and nothing is sent.
  const key = await require('./keys').resolve(env.DSHPROXY_HOME || undefined, route, {env, loadMasterKey});
  const transport = require('./transport');
  const options = {route, modelId:q.modelId, key, fetchImpl};
  const result = submitting ? await transport.submit({...options, prompt:args[6]}) : await transport.status({...options, jobId:args[3]});
  return emit({...result, model, route});
}
module.exports = {run};
