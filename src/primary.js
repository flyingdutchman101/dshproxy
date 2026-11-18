// The order in which a provider's accounts are used.
//
// With two plans at one provider, one account serves until it is out of quota
// and only then the next. Spreading every conversation across the accounts
// would look like pooling them, which providers suspend accounts for, and it
// loses the prompt cache.
//
// The backend picks the available credential with the highest priority, and
// moves to the next one inside the same request when the first refuses. So:
//
// - The primary account gets the highest priority and the provider's other
//   accounts a lower one.
// - An account whose whole limit is used up gets none: it steps aside until
//   the limit resets.
// - An account that has run out of one model only (Claude's weekly Fable
//   limit) keeps its place, and is told not to serve that model while another
//   account still has it.
//
// Without the last two the backend would ask an account that cannot answer
// first in every new conversation. The choice is kept in the DSHProxy
// settings and applied again when the gateway starts, so it does not depend
// on what the backend remembers.

const PRIMARY_PRIORITY = 10;
const SECONDARY_PRIORITY = 5;

const byFile = (accounts) => [...accounts].sort((a, b) => a.file.localeCompare(b.file));

// `accounts` are entries of accounts.list(); `primary` is { [provider]: file },
// where a provider with no file has its order taken back; `usedUp` holds the
// files of accounts that are out of quota. Only providers named in `primary`
// are touched, and only credentials whose priority differs are written.
// Returns { changed, failed }.
async function applyPrimary({ management, accounts, primary, usedUp = new Set() }) {
  const choice = primary && typeof primary === "object" ? primary : {};
  const current = new Map((await management.credentials()).map((item) => [item.name, Number(item.priority) || 0]));
  const changed = [];
  const failed = [];
  for (const account of byFile(accounts)) {
    if (!(account.provider in choice)) continue;
    const chosen = choice[account.provider];
    const wanted = !chosen || usedUp.has(account.file) ? 0 : chosen === account.file ? PRIMARY_PRIORITY : SECONDARY_PRIORITY;
    if ((current.get(account.file) ?? 0) === wanted) continue;
    try {
      await management.setPriority(account.file, wanted);
      changed.push(account.file);
    } catch (error) {
      failed.push({ file: account.file, error: error.message });
    }
  }
  return { changed, failed };
}

// `usedUpModels` is Map of file -> Map of model pattern -> reset time, for
// accounts that have run out of some models only. Such an account is told
// not to serve them, but only while another account of the provider can: a
// model nobody else has stays, so the provider's own refusal comes back.
// `sent` remembers what each account was last told, so nothing is sent
// twice; on a first run every account is told, which clears what an earlier
// run of the program left in the account's file. Returns { changed, failed },
// `changed` as [{ file, models }].
async function applyExclusions({ management, accounts, primary, usedUp = new Set(), usedUpModels = new Map(), sent }) {
  const choice = primary && typeof primary === "object" ? primary : {};
  const changed = [];
  const failed = [];
  for (const account of byFile(accounts)) {
    if (!(account.provider in choice)) continue;
    const others = accounts.filter((other) => other.provider === account.provider && other.file !== account.file && !other.disabled && !usedUp.has(other.file));
    const out = choice[account.provider] && !account.disabled ? [...(usedUpModels.get(account.file)?.keys() || [])] : [];
    const models = out.filter((pattern) => others.some((other) => !usedUpModels.get(other.file)?.has(pattern))).sort();
    const key = models.join(",");
    const before = sent.get(account.file);
    if (before === key) continue;
    try {
      await management.setExcludedModels(account.file, models);
      sent.set(account.file, key);
      if (key || before) changed.push({ file: account.file, models });
    } catch (error) {
      failed.push({ file: account.file, error: error.message });
    }
  }
  return { changed, failed };
}

// Keeps the backend's account order in step with the choice and the usage
// report. `primary()` returns the current choice; `limits` gives usedUp() and
// usedUpModels(); `listAccounts()` the signed-in accounts.
//
//   apply({ reset })  applies the order now; `reset` names a provider whose
//                     choice was taken back. Callers that arrive during a run
//                     share the one run that follows it.
//   refresh()         the same in the background, only when there is a
//                     choice; failures are logged.
//   idle()            resolves when no run is under way.
//   stop()            cancels the pending check; nothing runs afterwards.
//
// A run schedules the next one for a minute after the earliest reset it saw.
function createAccountOrder({ management, limits, listAccounts, primary, log = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const sent = new Map();
  const aside = new Set();
  const resets = new Set();
  let running = null;
  let queued = null;
  let timer = null;
  let stopped = false;

  async function run() {
    const accounts = listAccounts();
    const choice = { ...(primary() || {}) };
    for (const provider of resets) if (!choice[provider]) choice[provider] = null;
    resets.clear();
    if (!Object.keys(choice).length) return { changed: [], failed: [] };

    // A usage report that cannot be read leaves the order as chosen.
    let usedUp = new Map();
    let usedUpModels = new Map();
    try {
      [usedUp, usedUpModels] = await Promise.all([limits.usedUp({ accounts }), limits.usedUpModels({ accounts })]);
    } catch {
      usedUp = new Map();
      usedUpModels = new Map();
    }
    const out = new Set(usedUp.keys());
    const order = await applyPrimary({ management, accounts, primary: choice, usedUp: out });
    const models = await applyExclusions({ management, accounts, primary: choice, usedUp: out, usedUpModels, sent });

    const named = (file) => {
      const account = accounts.find((item) => item.file === file);
      return account ? `${account.label} (${account.account})` : file;
    };
    const until = (time) => new Date(time).toLocaleString();
    for (const account of accounts) {
      const file = account.file;
      if (!choice[account.provider]) {
        aside.delete(file);
        continue;
      }
      if (out.has(file) && !aside.has(file)) log(`account order: ${named(file)} is out of quota and steps aside until ${until(usedUp.get(file))}`);
      else if (!out.has(file) && aside.has(file)) log(`account order: ${named(file)} is used again`);
      else if (order.changed.includes(file) && !out.has(file)) log(`account order: ${named(file)} is ${choice[account.provider] === file ? "the primary account" : "used after the primary account"}`);
      if (out.has(file)) aside.add(file);
      else aside.delete(file);
    }
    for (const item of models.changed) {
      const mine = usedUpModels.get(item.file);
      log(item.models.length
        ? `account order: ${named(item.file)} is out of ${item.models.join(", ")} and is not asked for it until ${until(Math.max(...item.models.map((pattern) => mine?.get(pattern) || 0)))}`
        : `account order: ${named(item.file)} is asked for every model again`);
    }
    const failed = [...order.failed, ...models.failed];
    for (const item of failed) log(`account order: ${named(item.file)} could not be set (${item.error})`);

    // Look again a minute after the first limit that is due to reset.
    const times = [...usedUp.values(), ...[...usedUpModels.values()].flatMap((patterns) => [...patterns.values()])];
    clearTimer(timer);
    timer = null;
    if (times.length && !stopped) {
      const wait = Math.min(...times) - now() + 60 * 1000;
      timer = setTimer(refresh, Math.min(Math.max(wait, 60 * 1000), 2 ** 31 - 1));
    }
    return { changed: [...order.changed, ...models.changed.map((item) => item.file)], failed };
  }

  function apply({ reset = null } = {}) {
    if (reset) resets.add(reset);
    if (stopped) return Promise.resolve({ changed: [], failed: [] });
    if (!running) {
      const started = run().finally(() => {
        if (running === started) running = null;
      });
      running = started;
      return started;
    }
    if (!queued) {
      queued = running.catch(() => {}).then(() => {
        queued = null;
        return apply();
      });
    }
    return queued;
  }

  function refresh() {
    if (stopped || !Object.keys(primary() || {}).length) return;
    apply().catch((error) => log(`account order not applied: ${error.message}`));
  }

  async function idle() {
    while (running || queued) await (queued || running).catch(() => {});
  }

  function stop() {
    stopped = true;
    clearTimer(timer);
    timer = null;
  }

  return { apply, refresh, idle, stop };
}

module.exports = { createAccountOrder, applyPrimary, applyExclusions, PRIMARY_PRIORITY, SECONDARY_PRIORITY };
