// One primary account per provider.
//
// With two plans at one provider, one account serves until it is out of quota
// and only then the next. Spreading every conversation across the accounts
// would look like pooling them, which providers suspend accounts for, and it
// loses the prompt cache.
//
// The backend picks the available credential with the highest priority, and
// moves to the next one inside the same request when the first refuses. So
// the primary account gets the highest priority and the provider's other
// accounts a lower one. An account whose limit is used up gets none: it
// steps aside until the limit resets, because the backend would otherwise
// ask it first in every new conversation. The choice is kept in the DSHProxy
// settings and applied again when the gateway starts, so it does not depend
// on what the backend remembers.

const PRIMARY_PRIORITY = 10;
const SECONDARY_PRIORITY = 5;

// `accounts` are entries of accounts.list(); `primary` is { [provider]: file };
// `usedUp` holds the files of accounts that are out of quota. Only providers
// with a recorded choice are touched, and only credentials whose priority
// differs are written. Returns { changed, failed }.
async function applyPrimary({ management, accounts, primary, usedUp = new Set() }) {
  const choice = primary && typeof primary === "object" ? primary : {};
  const current = new Map((await management.credentials()).map((item) => [item.name, Number(item.priority) || 0]));
  const changed = [];
  const failed = [];
  for (const account of [...accounts].sort((a, b) => a.file.localeCompare(b.file))) {
    const chosen = choice[account.provider];
    if (!chosen) continue;
    const wanted = usedUp.has(account.file) ? 0 : chosen === account.file ? PRIMARY_PRIORITY : SECONDARY_PRIORITY;
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

module.exports = { applyPrimary, PRIMARY_PRIORITY, SECONDARY_PRIORITY };
