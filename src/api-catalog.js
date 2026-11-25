// Informational only: never adds models to backend configuration or routing.
// Discovery uses only OpenRouter's public metadata (architecture modalities).
// Other providers require credentials or lack verified public chat metadata;
// their built-ins remain visible. Custom URLs are never contacted. Cache is
// process-local; GET performs no network or credential access.
const { API_PROVIDERS, providerModels, providerRegionKey } = require('./catalog');
const https = require('node:https');
const WARNINGS = ['Discovery supports public OpenRouter chat metadata only; other providers and custom endpoints use local configuration. Discovered models are catalog-only, not enabled routes.'];
function publicModels() {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, data) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(data); };
    const req = https.get('https://openrouter.ai/api/v1/models', {headers:{accept:'application/json'}}, res => {
      if (res.statusCode !== 200) { res.destroy(); finish(new Error('metadata unavailable')); return; }
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) { res.destroy(); finish(new Error('metadata byte limit')); } else chunks.push(chunk); });
      res.on('error', error => finish(error));
      res.on('end', () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { finish(error); } });
    });
    const timer = setTimeout(() => { req.destroy(); finish(new Error('metadata timeout')); }, 5000);
    req.on('error', error => finish(error));
  });
}
function createApiCatalog({ settings, readable = {}, custom = [], fetchMetadata = publicModels }) {
  let discovered = [], warning = null, pending;
  function snapshot() {
    const rows = new Map();
    for (const [provider, definition] of Object.entries(API_PROVIDERS)) {
      const selected = providerRegionKey(provider, readable[provider]?.region || settings.providers?.[provider]?.region);
      for (const region of Object.keys(definition.regions)) for (const model of providerModels(provider, region)) {
        if (!rows.has(model.id)) rows.set(model.id, {id:model.id, provider, status:'needsKey', regions:[]});
        rows.get(model.id).regions.push(region);
      }
      for (const row of rows.values()) if (row.provider === provider) row.status = !row.regions.includes(selected) ? 'otherRegion' : readable[provider] ? 'ready' : 'needsKey';
    }
    for (const endpoint of settings.custom || []) for (const model of endpoint.models) {
      const id = `${endpoint.name}/${model}`;
      if (!rows.has(id)) rows.set(id, {id,provider:endpoint.name,status:custom.some(e => e.name === endpoint.name && e.models.includes(model)) ? 'ready' : 'needsKey',regions:[]});
    }
    for (const row of discovered) if (!rows.has(row.id)) rows.set(row.id,row);
    return {models:[...rows.values()].sort((a,b) => a.id.localeCompare(b.id)),warnings:[...WARNINGS,...(warning ? [warning] : [])]};
  }
  return async refresh => {
    if (refresh) {
      if (!pending) pending = (async () => {
        try {
          const data = await fetchMetadata();
          if (!Array.isArray(data.data)) throw new Error('invalid metadata');
          discovered = data.data.slice(0,10000).filter(m => typeof m.id === 'string' && /^[A-Za-z0-9._:/-]{1,200}$/.test(m.id) && m.architecture?.input_modalities?.includes('text') && m.architecture?.output_modalities?.length === 1 && m.architecture.output_modalities[0] === 'text').slice(0,2000).map(m => ({id:`openrouter/${m.id}`,provider:'openrouter',status:'catalogOnly',regions:Object.keys(API_PROVIDERS.openrouter.regions)}));
          warning = null;
        } catch { warning = 'OpenRouter public metadata refresh failed; retained previous catalog.'; }
      })().finally(() => { pending = null; });
      await pending;
    }
    return snapshot();
  };
}
module.exports = { createApiCatalog };
