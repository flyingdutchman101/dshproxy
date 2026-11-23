# 0006 — Pay-per-use video routes can be bought from chat

Accepted 2026-11-23 by the user's choice ("Krea and the API-key providers"), made after being told what follows. Replaces the last clause of the "Unchanged" paragraph of 0004 ("paid generation from DeepSeek Harness stays on the Krea route until a separate decision covers API routes"). This is that decision.

**What is new.** Picker entries (0005) exist for VideoRouter, KovAPI and Callirra as well as Krea, and a confirmed quote on one of them buys a clip with the user's saved key.

**The quote on these routes is not live.** On Krea every quote is a preflight in the signed-in workspace, and the purchase takes a fresh one and refuses when it exceeds the confirmed amount. VideoRouter, KovAPI and Callirra offer no such check. The quote there is the published price DSHProxy recorded for that model and resolution, with its date; no request is made to the provider before the job; the cap is compared with that same recorded number. If the provider has changed its price since, the bill differs and nothing notices before the job. Every such quote says so in its own line.

**What limits it.** The 24-hour ceiling in US dollars and in Callirra credits (0005), counted from the recorded prices. VideoRouter requests name the host the price belongs to and switch fallbacks off, so a job cannot move to a dearer host. A resolution is sent only to a host that lists it.

**Unchanged.** The key is resolved inside the child process that makes the one request; the gateway process never reads it. One send per job, no retry, no fallback.
