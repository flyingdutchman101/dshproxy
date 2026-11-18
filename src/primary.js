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
// first in every new conversation.
//
// The backend keeps both the priority and the excluded models in each
// account's file. DSHProxy owns them: every run compares what the backend
// holds with what the settings and the usage report ask for, so a choice
// that was taken back, or made while the gateway was not running, never
// leaves an old order behind. A paused account is left alone until it is
// resumed.

const PRIMARY_PRIORITY = 10;
const SECONDARY_PRIORITY = 5;
const RETRY_MS = 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;

const active = (accounts) => accounts.filter((account) => !account.disabled).sort((a, b) => a.file.localeCompare(b.file));
const choiceOf = (primary) => (primary && typeof primary === "object" ? primary : {});

// `accounts` are entries of accounts.list(); `primary` is { [provider]: file };
// `usedUp` holds the files of accounts that are out of quota. An account of a
// provider without a choice gets no priority. Only credentials whose priority
// differs are written. Returns { changed, failed }.
async function applyPrimary({ management, accounts, primary, usedUp = new Set() }) {
  const choice = choiceOf(primary);
  const current = new Map((await management.credentials()).map((item) => [item.name, Number(item.priority) || 0]));
  const changed = [];
  const failed = [];
  for (const account of active(accounts)) {
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
// An account of a provider without a choice is told to serve everything.
//
// The backend does not report what an account was told, so `sent` remembers
// it: a list is sent when it differs, and to every account `sent` does not
// know yet. Returns { changed, failed }, `changed` as [{ file, models }].
async function applyExclusions({ management, accounts, primary, usedUp = new Set(), usedUpModels = new Map(), sent }) {
  const choice = choiceOf(primary);
  const changed = [];
  const failed = [];
  const list = active(accounts);
  for (const account of list) {
    const others = list.filter((other) => other.provider === account.provider && other.file !== account.file && !usedUp.has(other.file));
    const out = choice[account.provider] ? [...(usedUpModels.get(account.file)?.keys() || [])] : [];
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
// usedUpModels(), which are read only when there is a choice;
// `listAccounts()` the signed-in accounts.
//
//   apply()                applies the order now. Callers that arrive during
//                          a run share the one run that follows it.
//   refresh({ ifChosen })  the same in the background; failures are logged.
//                          With `ifChosen`, only when there is a choice.
//   forget()               the accounts changed: tell every account again.
//   idle()                 resolves when no run is under way.
//   stop()                 cancels the pending check; nothing runs afterwards.
//
// A run schedules the next one for a minute after the earliest reset it saw.
// When something could not be set it is tried again after a minute, then
// after two, four and so on up to an hour, until it works.
function createAccountOrder({ management, limits, listAccounts, primary, log = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const sent = new Map();
  const aside = new Set();
  let running = null;
  let queued = null;
  let timer = null;
  let stopped = false;
  let failures = 0;
  let generation = 0;

  const chosen = () => Object.keys(choiceOf(primary())).length > 0;

  function retry() {
    failures += 1;
    schedule(Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS));
  }

  function schedule(delay) {
    clearTimer(timer);
    timer = stopped ? null : setTimer(() => refresh(), Math.min(Math.max(delay, RETRY_MS), 2 ** 31 - 1));
  }

  async function run() {
    const accounts = listAccounts();
    const choice = { ...choiceOf(primary()) };

    // A usage report that cannot be read leaves the order as chosen.
    let usedUp = new Map();
    let usedUpModels = new Map();
    if (Object.keys(choice).length) {
      try {
        [usedUp, usedUpModels] = await Promise.all([limits.usedUp({ accounts }), limits.usedUpModels({ accounts })]);
      } catch {
        usedUp = new Map();
        usedUpModels = new Map();
      }
    }
    const out = new Set(usedUp.keys());
    const order = await applyPrimary({ management, accounts, primary: choice, usedUp: out });
    const told = generation;
    const models = await applyExclusions({ management, accounts, primary: choice, usedUp: out, usedUpModels, sent });
    // The accounts changed while the backend was answering: what was just
    // sent may have gone to a file that has since been replaced.
    if (told !== generation) sent.clear();

    const named = (file) => {
      const account = accounts.find((item) => item.file === file);
      return account ? `${account.label} (${account.account})` : file;
    };
    const until = (time) => new Date(time).toLocaleString();
    for (const account of accounts) {
      const file = account.file;
      if (!choice[account.provider] || account.disabled) {
        if (order.changed.includes(file)) log(`account order: ${named(file)} has no place in an order now`);
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

    // Look again a minute after the first limit that is due to reset, or in a
    // minute when the backend refused something.
    const times = [...usedUp.values(), ...[...usedUpModels.values()].flatMap((patterns) => [...patterns.values()])];
    if (failed.length) retry();
    else {
      failures = 0;
      if (times.length) schedule(Math.min(...times) - now() + 60 * 1000);
      else {
        clearTimer(timer);
        timer = null;
      }
    }
    return { changed: [...order.changed, ...models.changed.map((item) => item.file)], failed };
  }

  function apply() {
    if (stopped) return Promise.resolve({ changed: [], failed: [] });
    // A run that is waiting to start serves every caller that arrives.
    if (queued) return queued;
    if (!running) {
      const started = run()
        .catch((error) => {
          // The backend did not answer: nothing was applied, so try again.
          retry();
          throw error;
        })
        .finally(() => {
          if (running === started) running = null;
        });
      running = started;
      return started;
    }
    const next = running.catch(() => {}).then(() => {
      if (queued === next) queued = null;
      return apply();
    });
    queued = next;
    return next;
  }

  function refresh({ ifChosen = false } = {}) {
    if (stopped || (ifChosen && !chosen())) return;
    apply().catch((error) => log(`account order not applied: ${error.message}`));
  }

  function forget() {
    generation += 1;
    sent.clear();
  }

  async function idle() {
    while (running || queued) await (queued || running).catch(() => {});
  }

  function stop() {
    stopped = true;
    clearTimer(timer);
    timer = null;
  }

  return { apply, refresh, forget, idle, stop };
}

module.exports = { createAccountOrder, applyPrimary, applyExclusions, PRIMARY_PRIORITY, SECONDARY_PRIORITY };
