# Foreplay tools (opt-in)

The `dshproxy-video` host plugin registers `foreplay_search({query})` and
`foreplay_boards({})` only when the configured DSHProxy home's dedicated
`foreplay-tools.json` decision enables them at plugin load. With no decision file,
legacy explicit plugin config `foreplayEnabled: true` remains supported. A local
false decision overrides that fallback; malformed/unreadable files fail closed.
The CLI uses `provider-picker/foreplay-tools` (`enabled(home)`, `await set(home,on)`)
to persist this decision atomically, independently of the picker and video toggles.
Enabling requires reloading the already-installed plugin (or restarting Harness)
to register tools. This control does not install plugins or edit live profiles.

Each invocation uses Harness `userQuestions.ask` with `intent.kind: approval`.
Only the exact `Run once` selection authorizes one request. Missing interfaces,
skips, custom text, delegated/nested calls, and cancellation before dispatch do
not send. Approval is never an argument. Search shows the exact query and up to
10 credits (1 per returned ad); boards shows 1 credit per successful nonempty
call. Provider pricing controls the debit, not a server-enforced price cap.
There is no retry or automatic pagination. Uncertain outcomes must not be retried
automatically. Returned labels/IDs are untrusted provider data.

After approval the existing fixed Node child runner invokes the actual research
CLI module with `--confirm-credits`. The bridge does not forward environment API
keys: use `dshproxy research key set` with piped stdin, in the same DSHProxy home
as the plugin (`home` config / `DSHPROXY_HOME`). Never put a key in tool arguments.

Disabling takes effect for existing tool handles immediately: the policy is checked
before asking, after approval before dispatch, and again in the child before execution.
An already-open approval cannot override a subsequent disable. Reload removes stale
registered handles from the tool list. Requests already executing cannot be recalled.
Live paid requests were not tested; tests use synthetic external-service boundaries.
