// Turns the model ID a client sends into the list of models to try.

const { findModel, providerModels, laneName } = require("./catalog");

// `accounts` is the set of subscription providers with a usable account;
// `providers` is { [providerKey]: { region } } for API keys that can be read.
function availability({ accounts, providers }) {
  return (id) => {
    const model = findModel(id);
    if (!model) return false;
    if (model.account) return accounts.has(model.account);
    const configured = providers[model.provider];
    return Boolean(configured) && providerModels(model.provider, configured.region).some((item) => item.id === id);
  };
}

// A lane resolves to the rungs that can serve right now, in ladder order. Any
// other ID is a real model and is tried as it is — with siblings behind it as a
// safety net, so a forced pick that runs out of quota is served by another model
// of the same provider instead of failing the request.
//
// `siblings(id)` optionally returns other models served by the same account,
// which covers models that are not part of any lane. `accountOf(id)` lets the
// ordering prefer the picked model's own provider: a Claude pick should be
// answered by another Claude model before a Gemini one.
function createResolver({ lanes, isAvailable, siblings = () => [], accountOf = () => null }) {
  return (id) => {
    const name = laneName(id);
    const ladder = name ? lanes()[name] : null;
    if (ladder) return { lane: name, ladder: ladder.filter((model) => isAvailable(model)) };
    const available = (models) => models.filter((model) => model !== id && isAvailable(model));
    const laneFallbacks = [];
    for (const candidate of Object.values(lanes())) {
      if (!Array.isArray(candidate) || !candidate.includes(id)) continue;
      laneFallbacks.push(...available(candidate));
      break;
    }
    const accountFallbacks = available(siblings(id));
    // Prefer the picked model's own family (`ag-*` before `gemini-*`, `claude-*`
    // before anything else on the same account) so a Claude-via-Google pick is
    // answered by Claude-via-Google when possible.
    const family = (model) => String(model).split("-")[0];
    const sameFamily = accountFallbacks.filter((model) => family(model) === family(id));
    const otherFamily = accountFallbacks.filter((model) => family(model) !== family(id));
    const orderedAccount = [...sameFamily, ...otherFamily];
    const account = accountOf(id);
    const sameProvider = account != null && laneFallbacks.length > 0 && laneFallbacks.every((model) => accountOf(model) === account);
    const ordered = sameProvider ? [...laneFallbacks, ...orderedAccount] : [...orderedAccount, ...laneFallbacks];
    const seen = new Set([id]);
    const fallbacks = ordered.filter((model) => {
      if (seen.has(model)) return false;
      seen.add(model);
      return true;
    });
    return fallbacks.length ? { lane: null, ladder: [id], fallbacks } : { lane: null, ladder: [id] };
  };
}

function describe(id) {
  const model = findModel(id);
  return model ? { efforts: model.efforts, upstream: model.upstream || null } : {};
}

module.exports = { availability, createResolver, describe };
