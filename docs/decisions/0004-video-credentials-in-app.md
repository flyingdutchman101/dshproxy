# 0004 — Save video API keys and start the Krea sign-in from the desktop app

Accepted 2026-11-22 at the user's request ("make a way to add keys to API keys in video models and auth Krea model under accounts"). Changes two points of 0002 and 0003; everything else in them stands.

**Video API keys may be saved.** 0002 allowed process-scoped environment variables only, with no credential persistence. Keys for the pay-per-use video providers can now be saved in `<DSHPROXY_HOME>/video-keys.json`, encrypted with the same master key as the Chat API keys. An environment variable, when set, still wins. The protection is the Chat keys' protection: at rest for the current Windows user, not against other programs running as that user.

**The app may start the Krea sign-in.** 0003 limited sign-in to an explicit `login` typed in a terminal, which prints the consent address. A button in the app now runs the same helper command and opens that address in the default browser, after checking it is `https` on a Krea host. It is still one explicit user action per sign-in; nothing signs in on its own or renews a session. The token stays inside the helper: the app sees the consent address, the exit code and `status` (signed in or not, and until when).

Unchanged: video jobs never go through the chat gateway; one send per job, no retry or fallback; the routing CLI never imports the helper or holds its token; paid generation from DeepSeek Harness stays on the Krea route until a separate decision covers API routes.

Cost of this decision: a saved key can be used by any DSHProxy video command the user, or an agent with a shell running as the user, starts. That was already true of a key in a persistent environment variable.
