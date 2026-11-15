# DeepSeek Harness gateway — ledger

## State (2026-11-15)

First version written and committed locally. Not pushed. Not applied to the real DeepSeek Harness profiles. No real account has been signed in through it.

## Rulings

- No fork of CLIProxyAPI or DroidProxy — because the backend changes daily and nothing in the Windows app depended on the DroidProxy sources — cost if wrong: a fix that needs backend internals has to go upstream or into a plugin.
- Lanes replace Auto routing — because DeepSeek Harness already names its lanes and ladders in its working defaults — cost if wrong: task-type and quota-aware routing would have to be added to the gateway.
- Separate ports (8417, 8418) and a separate auth folder — because the existing app must keep running unchanged — cost if wrong: each subscription has to be signed in a second time.
- The `Anthropic-Beta` rewrite and thinking-block removal were not carried over — because two single-turn probes showed no difference with and without them — cost if wrong: Claude requests fail or lose visible thinking in long tool-using conversations, and the rewrite has to be added to `src/gateway/request.js`.
- A rejection is judged by its text only when another rung could take the request, and only up to 64 KB — because reading every reply would delay streaming — cost if wrong: an oversized error body is returned instead of failing over.

## Evidence

- `npm test`: 105 tests pass. `npm run check`: 25 files.
- Real backend: CLIProxyAPI 8.0.72 downloaded, checksum matched, started on 127.0.0.1:8418. Model list through the gateway was identical to the backend's. Management paths returned 404. Neither port answered on the LAN address.
- Orphan recovery: a backend started by hand and recorded in `backend.pid` was stopped by the next `start`; VeryCuteDroidProxy's backend (another path) kept running.
- Profile sync: applied to a copy of the real `desktop` and `web` profiles. Every entry other than the `dshgate-*` routes was identical, and the comment count was unchanged.
- API key commands: a made-up key was saved, listed, offered as models and removed. It did not appear in `settings.json` or `master.key`.

## Not checked

- Any request served by a real model through the gateway. Failover was tested against a stand-in backend only.
- `login` for any provider.
- DeepSeek Harness loading the written routes.
- Claude thinking across several turns with tool use.
- A secret scan with gitleaks or trufflehog (neither is installed).

## Next

1. Decide whether dshgate shares `~/.cli-proxy-api` with VeryCuteDroidProxy or gets its own sign-ins.
2. Sign in, run `dsh apply`, and send one request per lane.
3. Decide whether the DeepSeek Harness default model, delegation lanes and `allowedModels` should point at dshgate.
