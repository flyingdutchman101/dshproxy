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
// other ID is a real model and is tried as it is.
function createResolver({ lanes, isAvailable }) {
  return (id) => {
    const name = laneName(id);
    const ladder = name ? lanes()[name] : null;
    if (!ladder) return { lane: null, ladder: [id] };
    return { lane: name, ladder: ladder.filter((model) => isAvailable(model)) };
  };
}

function describe(id) {
  const model = findModel(id);
  return model ? { efforts: model.efforts, upstream: model.upstream || null } : {};
}

module.exports = { availability, createResolver, describe };
