# DeepSeekProxy (DSHProxy)

A local model gateway for DeepSeek Harness on Windows and macOS. It runs a pinned, unmodified [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) release and puts one small HTTP server in front of it.

DeepSeek Harness gets two kinds of model from it:

- **Real models**, such as `claude-fable-5-2` or `deepseek/deepseek-v4-pro`. A request for one is passed to CLIProxyAPI unchanged.
- **Lanes**, such as `lane-main` or `lane-reviewer`. A lane is one model ID that stands for a ladder of real models. The request is tried on each rung in order until one serves it.

It is a standalone project. It shares no code or git history with DroidProxy or VeryCuteDroidProxy, and it can run beside VeryCuteDroidProxy (which uses ports 8317 and 8318).

## Requirements

- Windows, x64 or arm64, or macOS on Apple Silicon or Intel
- Node.js 22 or later

## macOS

The gateway and the command line work on macOS as on Windows: sign in to providers, save API keys, apply the routes to DeepSeek Harness, chat through a lane, stop, update the backend. Install and run them as in [Set up from the command line](#set-up-from-the-command-line), in Terminal:

```sh
npm ci --ignore-scripts
node bin/dshproxy.js login claude
node bin/dshproxy.js key set deepseek    # the key is read from standard input
node bin/dshproxy.js start               # keep this window open
```

The first `start` downloads the macOS release of CLIProxyAPI for your processor and installs it only if its SHA-256 matches [backend.lock.json](backend.lock.json).

**Video on macOS** works as on Windows: the `video` commands, the paid entries in the DeepSeek Harness model picker, and the Krea sign-in (`node bin/dshproxy-krea.js login`), which is kept in `~/Library/Application Support/DSHProxy/KreaOAuth/`, readable by your account only and encrypted with the same Keychain-held key. `dshproxy dsh bundle install` finds DeepSeek Harness in `/Applications` or `~/Applications` (or `DSHPROXY_HARNESS_DIR`) and runs its own `dsh plugin` command; quit DeepSeek Harness first.

**Not there yet on macOS.** The app: there is no window and no menu-bar icon, and nothing starts at login.

**What protects which secret.** The key that encrypts your saved API keys (`master.key`) is wrapped with a key DSHProxy keeps in your login Keychain (an item named `DSHProxy`, account `key-wrapper`), as Windows wraps it with DPAPI. Every file and folder DSHProxy writes is readable by your account only. `backend-config.yaml` and `auth/` hold API keys and sign-ins in plain text, as on Windows, because CLIProxyAPI reads them from there. If your login Keychain is locked, macOS asks for its password; DSHProxy waits 10 seconds, then says that the Keychain is locked and saves nothing. Decision: [0009](docs/decisions/0009-keys-on-macos-are-wrapped-through-the-keychain.md).

`dsh apply` makes `~/.dsh/.credentials.yaml` readable by your account only every time, because DeepSeek Harness refuses one that others can read, and `dsh verify` reports one that is not.

## Windows app

`DSHProxy.exe` is a window and tray icon that runs the gateway and controls it:

- **Accounts**: one card per subscription with its plan and, for each limit window (5-hour, daily, weekly, monthly, and per-model limits such as Claude Fable), a bar of what is left and when it resets. ChatGPT accounts that have free limit resets show **Use a reset**. Bars turn amber below 30% and red below 10%, and a tray notification warns once when a limit drops to 10%. Pause, resume or sign out of an account (signing out asks first). **+ Add account** walks through sign-in: pick the service, the provider's page opens in your browser, and the window confirms which account was added. Kimi shows a short code to type instead.
- **API keys**: add, replace or remove keys.
- **Lanes**: each ladder, with ✓ can serve, ✗ no account or key, ⏸ sitting out.
- **DeepSeek Harness**: preview, apply or remove the routes.
- **Log**: live gateway output.

A switch at the top changes between the **Chat** workspace above and a **Video** workspace with the same sections: **Accounts** signs in to or out of a Krea workspace in your browser, **API keys** saves, replaces or removes the key of a pay-per-use video provider, **Lanes** sets the billing route of each video model, and **Models** switches video models on or off. See [Video routing](#video-routing-cli).

The window keeps its content in one centered column and fits itself to the screen it opens on; the smallest size is 860 by 600.

Provider logos are from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT) and are trademarks of their owners; see [app/logos/SOURCE.md](app/logos/SOURCE.md). They are built into the program, so it works offline.

Closing the window keeps the gateway running in the tray; quit from the tray menu. "Start with Windows" starts it hidden in the tray at sign-in.

Build it once with the C# compiler that ships with Windows (nothing to install):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File app\build.ps1
```

`DSHProxy.exe` must stay in this folder, next to `bin\dshproxy.js`. It needs Node.js on the PATH.

## Custom OpenAI-compatible endpoints

Anything that speaks the OpenAI API can be added as a keyed provider: a self-hosted [LiteLLM](https://github.com/berriai/litellm) or [One API](https://github.com/songquanpeng/one-api) gateway, OpenRouter, or your own service. Its models are offered to DeepSeek Harness as `<name>/<model>`, so they never collide with the subscription and catalog models.

```powershell
node bin/dshproxy.js key custom add litellm http://127.0.0.1:4000/v1 "gemini-2.5-pro,claude-opus-5-5"   # the key is read from standard input
node bin/dshproxy.js key custom list
node bin/dshproxy.js key custom remove litellm
```

Restart the gateway and run `dsh apply` afterwards, then restart DeepSeek Harness. The endpoint authenticates with its **API key** (sent as `Authorization: Bearer …`); an account sign-in is not used, so nothing here depends on a provider's IDE entitlements. That is also why the Google Gemini API (an AI Studio key) is offered as a normal API-key provider: it is the sanctioned route to Gemini models.

## Set up from the command line

```powershell
npm ci --ignore-scripts
node bin/dshproxy.js login claude        # also: codex, antigravity, kimi
node bin/dshproxy.js key set deepseek    # the key is read from standard input
node bin/dshproxy.js start               # keep this window open
```

In a second window:

```powershell
node bin/dshproxy.js dsh apply --dry-run   # shows what would change
node bin/dshproxy.js dsh apply
```

Then restart DeepSeek Harness. The models appear under four providers: `dshproxy-lanes`, `dshproxy-claude`, `dshproxy-openai` and `dshproxy-compat`.

The first `start` or `login` downloads the CLIProxyAPI release named in [backend.lock.json](backend.lock.json) and installs it only if its SHA-256 matches.

## Commands

| Command | What it does |
|---|---|
| `start` | Runs the gateway on `127.0.0.1:8417` and the backend on `127.0.0.1:8418` |
| `stop --when-idle [--wait SECONDS]` | Stops the running gateway at a moment with no request in flight. If none comes within the wait (300 seconds unless given), the gateway keeps running and the command exits with code 2 |
| `status` | Shows accounts, API keys, each lane's ladder, requests in flight and the DeepSeek Harness state |
| `login <provider>` | Signs in to a subscription with CLIProxyAPI's own login |
| `accounts` | Lists signed-in accounts |
| `key set <provider> [region]` | Saves an API key, encrypted |
| `key remove <provider>` | Removes a saved API key |
| `key list` | Lists API-key providers and their regions |
| `models` | Lists the models that can be offered right now |
| `backend version` | Shows the CLIProxyAPI version in use |
| `backend update` | Asks the running gateway to look for a newer CLIProxyAPI and switch to it, as the app's **Update...** does |
| `backend rollback` | With the gateway stopped, goes back to the previous CLIProxyAPI version |
| `dsh apply [--dry-run]` | Writes the models into every DeepSeek Harness profile; repairs a default model that is missing or names a DSHProxy model that is gone |
| `dsh verify` | Checks the profiles back: routes, base URLs, offered models, image caps, default model, credential, leftover DroidProxy providers |
| `dsh status` | Shows which DSHProxy routes each profile has |
| `dsh remove [--dry-run]` | Removes DSHProxy's routes from every profile |

## Lanes

The default ladders follow the model ladder in the DeepSeek Harness working defaults:

| Lane | Ladder |
|---|---|
| `lane-main` | `gpt-6-astra`, `claude-fable-5-2`, `claude-opus-5-5`, `gemini-4-carbon-high`, `deepseek/deepseek-v4-pro` |
| `lane-scout` | `claude-haiku-5-5`, `gemini-3.8-flash-high`, `gpt-6-luna`, `deepseek/deepseek-flash`, `qwen/qwen3.8-flash` |
| `lane-builder` | `gpt-6-astra`, `claude-sonnet-5-5`, `deepseek/deepseek-v4-pro`, `gemini-4-argon-high` |
| `lane-architect` | `claude-fable-5-2`, `gpt-6.1-terra`, `claude-opus-5-5`, `deepseek/deepseek-v4-pro`, `gemini-4-argon-high` |
| `lane-reviewer` | `gemini-4-carbon-high`, `deepseek/deepseek-v4-pro`, `claude-opus-5-5` |
| `lane-google` | `gemini-3.8-flash-high`, `gemini-4-carbon-high`, `gemini-4-hydrogen-xhigh`, `gemini-3.8-flash-tiered` |

The reviewer ladder has no GPT model. The main and builder lanes start on GPT, and the gateway cannot check which model wrote the code under review.

### Forced models are strict

A lane fails over. A single model does not: picking `gemini-4-carbon-high` runs `gemini-4-carbon-high`, and if it answers 429 that is what you get back — the gateway never answers with a different model. Use a lane when you want failover.

Inside a lane, an account that answers 429 on three of its models within 45 seconds is skipped as a whole for a minute, so a throttled provider is not walked model by model.
Change the ladders under `lanes` in `~/.dshproxy/settings.json`, then restart the gateway and run `dsh apply`.

### When a request moves to the next rung

| Upstream answer | What happens |
|---|---|
| HTTP 402, 429, 503 or 529 | The model sits out for as long as the provider says (`Retry-After`, up to a day), or for 10 minutes when it does not say. The request moves on. |
| HTTP 500, 502, 504 or no answer, three times in a row | Same as above. The first two are returned to the client. |
| A rejection saying the request is too long for the model | The request moves on. The model stays in use. |
| A rejection saying no signed-in account serves the model | The model sits out for 10 minutes. The request moves on. |
| Anything else, including every other HTTP 400 | The answer is returned to the client. |

A request never moves on because an answer looked weak. A rung with no account or API key is left out of the ladder. If every rung is sitting out, the whole ladder is tried anyway.

A conversation stays on the rung that last served it, so a recovered first rung does not pull it back mid-conversation. A conversation is identified by the `X-Session-ID` header, then `prompt_cache_key`, then its first user message.

Each response carries `x-dshproxy-model` (the model that served it) and, for a lane, `x-dshproxy-lane`.

The backend tries each request once. Retries and failover belong to the gateway alone, so a provider's refusal is one upstream call, not several.

A lane is declared to DeepSeek Harness with the smallest context window and output limit on its ladder, so a request sized for the lane fits every rung.

## What the gateway changes in a request

- The `model` field of a lane request becomes the rung that serves it.
- `ag-c55o-high` and `ag-c55s-high` are sent under the names Antigravity expects.
- A reasoning level the serving model does not accept is mapped to the nearest level it does accept.

A request that needs none of these reaches CLIProxyAPI byte for byte.

## What `dsh apply` writes

- The four `dshproxy-*` routes inside the `llm-pi-ai` entry of each profile's `cordis.patch.yml`.
- A `DSHPROXY_API_KEY` reference in `~/.dsh/.credentials.yaml`, if it is missing. DeepSeek Harness refuses a route whose key reference resolves to nothing; the gateway ignores the value.

It leaves every other entry, route and comment alone, including VeryCuteDroidProxy's `droidproxy-*` routes. It backs each profile up before changing it. Fields you add to a model entry, and its `input` list, are kept on the next sync.

It does not change the delegation lanes or `allowedModels`, nor a default model that names another provider. It sets the default model to a lane only when there is none, when it names no provider, or when it names a DSHProxy model that is gone (a lane counts as there even while none of its models can serve; `dsh verify` reports it); the gateway does the same when it updates the routes by itself. To let subagents use a DSHProxy route, add it to `allowedModels` yourself.

`dsh remove` takes the four routes out again. If `dsh apply` had to add the `llm-pi-ai` entry itself, `dsh remove` takes that out too, unless you have since put other routes in it. The `DSHPROXY_API_KEY` reference stays.

## Files

Everything is under `~/.dshproxy` (override with `DSHPROXY_HOME`):

| File | Contents |
|---|---|
| `settings.json` | Ports, lanes, and API keys in encrypted form |
| `master.key` | The key that encrypts the API keys, wrapped by Windows DPAPI for your account, or on macOS with a key kept in your login Keychain |
| `auth/` | Subscription credentials written by CLIProxyAPI |
| `backend-config.yaml` | The CLIProxyAPI configuration, rewritten on every start. **It holds your API keys in plain text**, because CLIProxyAPI reads them from there. |
| `bin/<version>/` | The installed CLIProxyAPI release |
| `dshproxy.log` | The gateway log |

If `settings.json` exists but cannot be read, every command stops with an error and leaves the file as it is. Fix the file, or move it away to start from the defaults.

## Attachments

DeepSeek Harness accepts two kinds of input: text and images (PNG, JPEG, WebP, GIF). Nothing else is sent to a model — a PDF, Word file or audio clip is not an attachment any model can receive through DeepSeek Harness, whatever the provider supports.

Images work on lanes without any setting. A lane declares image input when at least one rung accepts images, and the gateway then sends an image request only to those rungs, skipping text-only models (API-key models are declared text-only). A lane with no vision rung refuses the image immediately with "no model on this lane accepts images" instead of failing rung by rung.

The routes also keep a lid on image-heavy conversations: at most **12 images** and **8 MiB of image payload** per request. Providers shrink the per-image size limit once a request carries many images (Anthropic rejects anything over ~3000 px in that case), so DeepSeek Harness replaces older images with text placeholders instead of sending a request the provider will refuse. Large full-screen screenshots are still worth cropping before attaching.

## Lanes and routing presets

A lane is one model ID that tries a ladder of real models in order. The ladders come in three ready-made sets, switched on the **Lanes** tab (or with `dshproxy preset use <name>`); switching replaces all five ladders at once and re-applies the DeepSeek Harness routes:

| Preset | What it does |
|---|---|
| **Max performance** | The strongest model each lane can reach, whatever it costs. Slowest and most quota-hungry. |
| **Balanced** | Strong models first with cheaper ones as failover. The working default. |
| **Cheap production** | Subscription quota first, then the cheapest paid models. Leaves GPT and Opus out. |

Once the ladders have been edited by hand (in settings.json), the tab shows **Custom** until a preset is chosen again. The CLI can list the presets and the active one with `dshproxy preset list`; `dshproxy preset use` while a gateway is running needs a restart to take effect (the app switches it live).

## New models and backend updates

**Models are found automatically.** About 3 seconds after start and then every 3 hours, DSHProxy reads which models the backend serves to your accounts and CLIProxyAPI's public model catalog ([models.router-for.me](https://models.router-for.me/models.json)) for each model's context size, output limit and reasoning levels. A current-generation chat model that your accounts serve is offered without a DSHProxy update. Image models, older generations and models the catalog does not describe are hidden; switch any model on or off on the **Models** tab (saved as `models.extra` / `models.hidden` in settings.json). When the offered list changes, DSHProxy updates its routes in the DeepSeek Harness profiles that already have them (each backed up first) and asks you to restart DeepSeek Harness. Profiles you never applied DSHProxy to are not touched.

**Lanes are never changed for you.** When a newer version of a model on a lane appears (for example Fable 5.3 for Fable 5.2), the Models tab suggests it; nothing changes until you press **Use** and confirm.

**Backend updates.** Every 6 hours DSHProxy asks GitHub for the latest CLIProxyAPI release (no drafts or pre-releases). When one is newer, the app shows **Update...**. Updating:
1. downloads the release's archive for your system (the Windows zip, or the macOS `.tar.gz`) and checks it against the `checksums.txt` that release publishes (addresses outside the official release path are refused);
2. starts it on a spare loopback port with your accounts and sends one short request per signed-in service (an out-of-quota answer does not count against it);
3. only if that passes, switches `~/.dshproxy/backend.lock.json` to it, keeps the version it replaces, and restarts the gateway (a few seconds offline). The restart waits for a moment with no request in flight; if none comes within 15 minutes it restarts anyway and the log says how many requests were cut.

If the new version will not start, DSHProxy goes back to the previous one by itself. From the command line, `dshproxy backend update` does the same while the gateway runs. **Roll back...** in the app, or `dshproxy backend rollback` with the gateway stopped, returns to the previous version. The version shipped in the repo's `backend.lock.json` is the floor: an older update is ignored.

## Sign-in and limits

Sign-in and limits run through CLIProxyAPI's Management API, which the gateway switches on with a new random key every start (the backend keeps only a hash of it). The gateway never reads or sends a token itself:

- **Sign-in**: the backend creates the provider's sign-in link. The provider sends the browser back to a fixed address on this machine (port 54545 for Claude, 1455 for ChatGPT, 51121 for Gemini); DSHProxy listens there on loopback only while a sign-in is open, passes the address to the backend, and shows a confirmation page. The backend exchanges the code and saves the account. A sign-in left open expires after 5 minutes.
- **Limits**: the backend calls each provider's usage endpoint with the account's own token. ChatGPT, Claude and Gemini report limits; Kimi does not. Limits are read at most once a minute.
  - Claude: 5-hour and weekly, plus each per-model weekly limit the plan sets (for example "Weekly (Fable)" on team plans), read from the `limits` list in Claude's reply.
  - ChatGPT: the 5-hour window is always listed; plans that report none show "Not reported for this plan". Per-model limits are added when ChatGPT reports them.
  - Gemini: 5-hour and weekly for Gemini models and for Claude/GPT models served through Google.
- **Limit resets (ChatGPT)**: when ChatGPT offers free limit resets, the account card carries a red danger strip showing how many are left ("1 limit reset"), with **Use a reset…**. Using one is a danger-zone action: the dialog repeats the count, says it cannot be undone, and the **Use this reset** button stays disabled until you type `RESET`. ChatGPT keeps the reset if nothing is used up. These are the same resets the Codex CLI offers; Claude and Gemini do not offer resets.

The Windows app reaches these through a control API on the gateway (`/dshproxy/control/`). Each call needs the token in `~/.dshproxy/control.token`, which is new every start, and calls that come from a web page are refused.

## Security

- The gateway and the backend listen on `127.0.0.1` only. A `host` setting that names any other address is ignored.
- There is no client authentication. Any program on this machine can use your accounts through the gateway.
- CLIProxyAPI's plugins are switched off. Its Management API accepts only callers on this machine that hold the key generated at start, and its web control panel is off.
- A request larger than 256 MB is refused with HTTP 413.

## Known limits

- The gateway sets no time limit on a reply. If the backend stops sending without closing the connection, the request waits until the client gives up.
- Two conversations that begin with the same first user message, and send no session ID, count as one conversation for the purpose of staying on a rung.
- An installed backend is not checked again after the first install.
- Starting two gateways at the same moment for the first time can make one of the installs fail.
- A stop that waits for an idle moment never cuts a request the gateway has started to read. A connection that is open but has not sent its request at that moment is closed without an answer, and the client has to send the request again.
- Video keys, video settings and the first creation of `master.key` are safe when several commands run at the same moment. The chat `settings.json`, the DeepSeek Harness profile files and `backend.lock.json` are not locked: of two changes made at the same moment, one can be lost.

## Updating the backend

Edit `version`, the four `url` values and the four `sha256` values (Windows and macOS, two processors each) in [backend.lock.json](backend.lock.json). Take the checksums from `checksums.txt` on the CLIProxyAPI release page. The next `start` installs the new version.

## Tests

```powershell
npm test
npm run check
```

On macOS the tests use throwaway keychain files and never your login Keychain. The tests that lock a keychain make macOS show a password dialog, so they run only on CI or with `DSHPROXY_TEST_LOCKED_KEYCHAIN=1`. `node scripts/start-stop-check.js` downloads the backend, starts and stops it in a throwaway folder.

## Video routing (CLI)

From a source checkout, `node bin/dshproxy.js video help` works without starting the gateway. `video list` shows the supported model names. `video quote wan-3.0` prints a dated offline estimate for a five-second, native 720p, 16:9 text-only clip; H3 uses 768p. You can specify the route, for example `video quote minimax-h3 callirra`. Callirra's dollars are a **full-utilization subscription equivalent**, not a purchase or a cash rate. These API-route quotes never contact a provider.

**Krea workspace route (Windows and macOS, mock-tested release candidate).** The separate helper owns the workspace session; the routing CLI does not receive OAuth tokens. Sign-in is an explicit account operation, never an effect of a quote. After separately authorizing it, run `node bin/dshproxy-krea.js login` from this checkout (a registered public client may require `--client-id ID`). Select the intended Krea workspace during consent. An expired session requires another explicit login.

- `video quote MODEL krea --prompt "PROMPT"` contacts the signed-in workspace for a compute-unit preflight, not a USD estimate. Unknown tool shapes or unverified presets are refused. In particular, H3 needs an explicit 768p selector.
- `video submit MODEL krea --max-units COUNT --confirm-charge "PROMPT"` requests a fresh preflight before one generation call. The cap limits the quoted amount, not the final debit. `video status MODEL krea JOB_ID` checks the original job. After an uncertain submission check the workspace; never retry blindly.
- `video krea MODEL` remains an **offline manual handoff** for another OAuth-capable client. No workspace command falls back to API billing. Real OAuth issuer compatibility, model availability and actual charges require live verification before production use.

**Provider keys.** `video key set PROVIDER` saves the key of a pay-per-use provider (`videorouter`, `kovapi`, `callirra`). The key is read from standard input, never from the command line, and is stored in `video-keys.json` in the data folder, encrypted with the same master key as the chat API keys. `video key list` shows which providers have a saved key and whether one is set in the environment; `video key remove PROVIDER` deletes it. A key in the provider's environment variable (`VIDEOROUTER_API_KEY`, `KOVAPI_API_KEY`, `CALLIRRA_API_KEY`) is used instead of a saved one. A saved key is not checked against the provider.

For an explicitly paid run, use `video submit MODEL ROUTE --max-usd AMOUNT --confirm-charge "PROMPT"`, with the provider key saved or in the environment. For Callirra, use `--max-credits 10` instead of a dollar budget: the provider bills credits. The limit checks the local estimate per submission, **not** the provider's final debit or a cumulative budget. Rates may change. Save the returned model, route and job ID; use `video status MODEL ROUTE JOB_ID` to check progress. Nothing automatically retries a submission or changes hosts. After an ambiguous failure, check the provider dashboard before trying again. Output URLs may be short-lived and private; do not share job output or paste secrets into prompts.

The Windows app's **Video** workspace edits the same settings: which models are on, the billing route of each, the provider keys, and the Krea sign-in. Nothing is generated or charged from the window, and video models are not chat models.

## Not included

Compared with VeryCuteDroidProxy, DSHProxy leaves these out:

- Factory Droid model sync, Factory modes and the Workstream manager
- A window, tray icon or installer
- Auto routing by task type, and routing by remaining quota or weekly pace
- Routing that uses the remaining limits (limits are shown, not yet used to pick a model)
- Voice generation and video generation through chat lanes
- The Claude `Anthropic-Beta` rewrite and the removal of old thinking blocks

## Two accounts with one provider

Sign in a second account of the same provider (for example two Claude plans) and DSHProxy uses both, one at a time:

- One account is the **primary**. It serves every request until it is out of quota. Only then does the other account take over, inside the same request, so nothing fails.
- Pick the primary on the Accounts page (**Make primary**, and **Not primary** to take it back) or with `dshproxy accounts primary <provider> <account|none>`. The choice is kept in `~/.dshproxy/settings.json` under `primary` and applied again each time the gateway starts.
- An account whose 5-hour or weekly limit is used up steps aside until that limit resets, so it is not asked first while it cannot answer.
- An account that has run out of one model only (Claude's weekly Fable limit) keeps its place for the other models. It is told not to serve that model until the limit resets, as long as another account still has it. If no other account has it, nothing changes and the provider's own refusal comes back.
- Without a choice the accounts take turns per conversation.
- A model counts as out of quota only when every active account of the provider is out. Until then a lane keeps using it.

DSHProxy learns all of this from the provider's usage report, the same one the Accounts page shows, and looks again a minute after a limit is due to reset. The backend keeps the order and the model exclusion in each account's sign-in file; DSHProxy sets both again from its own settings every time it starts.

This is meant for plans you own and would otherwise use by hand, one after the other. It does not rotate requests across accounts to get around a plan's limits: providers treat that as abuse and suspend accounts for it. Using a subscription sign-in through any gateway is at the provider's discretion; an API key is the route their terms describe for programs.

## License

MIT, see [LICENSE](LICENSE). CLIProxyAPI is a separate project under its own license; DSHProxy downloads its released binary and does not include its source.
