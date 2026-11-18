// Decides when a model has stopped serving and for how long to avoid it.
//
// - Capacity (402, 429, 503, 529): the model is out of quota, out of balance
//   or overloaded. It sits out for a while and the request moves to the next
//   rung.
// - Transient (500, 502, 504, or no response at all): counted per model. The
//   third in a row is treated like capacity; earlier ones go back to the
//   client, which retries.
// - A rejection whose text says the request is too long for this model moves
//   the request to the next rung, but the model stays in use: a shorter
//   request still fits.
// - A rejection whose text says no signed-in account serves this model makes
//   the model sit out like capacity.
// - How long a model sits out: as long as the provider says (its Retry-After
//   header, or the reset time in its usage report), up to a day. Without
//   either it is a ten-minute guess, and a guess never replaces a time the
//   provider gave.
// - Any other answer (success, or a request error such as 400) is returned to
//   the caller. A bad request is the caller's to fix; another model would not
//   help, and a weak answer is never a reason to switch models.

const CAPACITY = new Set([402, 429, 503, 529]);
const TRANSIENT = new Set([0, 500, 502, 504]);
const REJECTION = new Set([400, 404, 413, 422]);

const TOO_LONG = /context_length_exceeded|context_window_exceeded|maximum context length|prompt is too long|input is too long|exceeds? the (model'?s? )?(maximum )?context/i;
const UNAVAILABLE = /unknown provider for model|model_not_found|auth_unavailable|no auth available/i;

// True when the response text is needed to judge this status.
function needsBody(status) {
  return REJECTION.has(status);
}

function createFailover({ now = Date.now, cooldownMs = 10 * 60 * 1000, maxCooldownMs = 24 * 60 * 60 * 1000, threshold = 3 } = {}) {
  // model -> { until, source }. `source` is "provider" when the provider said
  // when the model returns (a Retry-After header, or its usage report), and
  // "default" when the end is this gateway's guess.
  const cooling = new Map();
  const strikes = new Map();

  function held(model) {
    const entry = cooling.get(model);
    if (!entry) return null;
    if (entry.until <= now()) {
      cooling.delete(model);
      return null;
    }
    return entry;
  }

  const isCooling = (model) => held(model) !== null;

  // A guess never replaces an end the provider gave: the provider knows.
  function set(model, until, source) {
    const current = held(model);
    const entry = current && current.source === "provider" && source === "default" ? current : { until, source };
    cooling.set(model, entry);
    strikes.delete(model);
    return entry;
  }

  // `retryAfter` is the upstream Retry-After header in seconds, when given.
  function cool(model, retryAfter) {
    const seconds = Number(retryAfter);
    const given = Number.isFinite(seconds) && seconds > 0;
    return set(model, now() + (given ? Math.min(seconds * 1000, maxCooldownMs) : cooldownMs), given ? "provider" : "default");
  }

  // Cools a model until a time the provider gave some other way.
  function coolUntil(model, until) {
    return new Date(set(model, Math.min(until, now() + maxCooldownMs), "provider").until);
  }

  // The rungs to try, in order. Cooling rungs are skipped unless every rung is
  // cooling, so a request is never refused without being tried.
  function order(ladder) {
    const rungs = ladder.filter((model, index) => model && ladder.indexOf(model) === index);
    const open = rungs.filter((model) => !isCooling(model));
    return open.length ? open : rungs;
  }

  const cooled = (entry, reason) => ({ failover: true, until: new Date(entry.until), reason, source: entry.source });
  // `status` is the upstream HTTP status, or 0 when the backend did not
  // answer. `body` is the response text, when the caller has it. Returns
  // whether to move to the next rung, why, until when the model sits out (null
  // when it stays in use) and where that time came from.
  function report(model, status, retryAfter, body) {
    if (CAPACITY.has(status)) return cooled(cool(model, retryAfter), `returned HTTP ${status}`);
    if (TRANSIENT.has(status)) {
      const count = (strikes.get(model) || 0) + 1;
      if (count >= threshold) return cooled(cool(model), status ? `returned HTTP ${status} ${count} times in a row` : `did not answer ${count} times in a row`);
      strikes.set(model, count);
      return { failover: false, until: null, reason: "", source: null };
    }
    strikes.delete(model);
    if (REJECTION.has(status) && typeof body === "string") {
      if (UNAVAILABLE.test(body)) return cooled(cool(model), "is not served by any signed-in account");
      if (TOO_LONG.test(body)) return { failover: true, until: null, reason: "cannot fit this request", source: null };
    }
    return { failover: false, until: null, reason: "", source: null };
  }

  function coolingUntil(model) {
    const entry = held(model);
    return entry ? new Date(entry.until) : null;
  }

  return { order, report, isCooling, coolingUntil, coolUntil };
}

module.exports = { createFailover, needsBody, CAPACITY, TRANSIENT };
