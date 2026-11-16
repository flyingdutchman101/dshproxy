# dshgate

A local model gateway for DeepSeek Harness on Windows. It runs a pinned, unmodified [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) release and puts one small HTTP server in front of it.

DeepSeek Harness gets two kinds of model from it:

- **Real models**, such as `claude-fable-5-2` or `deepseek/deepseek-v4-pro`. A request for one is passed to CLIProxyAPI unchanged.
- **Lanes**, such as `lane-main` or `lane-reviewer`. A lane is one model ID that stands for a ladder of real models. The request is tried on each rung in order until one serves it.

It is a standalone project. It shares no code or git history with DroidProxy or VeryCuteDroidProxy, and it can run beside VeryCuteDroidProxy (which uses ports 8317 and 8318).

## Requirements

- Windows, x64 or arm64
- Node.js 22 or later

## Windows app

`dshgate.exe` is a window and tray icon that runs the gateway and controls it:

- **Accounts**: one card per subscription with its plan and, for each limit window (5-hour, daily, weekly, monthly, and per-model limits such as Claude Fable), a bar of what is left and when it resets. ChatGPT accounts that have free limit resets show **Use a reset**. Bars turn amber below 30% and red below 10%, and a tray notification warns once when a limit drops to 10%. Pause, resume or sign out of an account (signing out asks first). **+ Add account** walks through sign-in: pick the service, the provider's page opens in your browser, and the window confirms which account was added. Kimi shows a short code to type instead.
- **API keys**: add, replace or remove keys.
- **Lanes**: each ladder, with ✓ can serve, ✗ no account or key, ⏸ sitting out.
- **DeepSeek Harness**: preview, apply or remove the routes.
- **Log**: live gateway output.

Provider logos are from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT) and are trademarks of their owners; see [app/logos/SOURCE.md](app/logos/SOURCE.md). They are built into the program, so it works offline.

Closing the window keeps the gateway running in the tray; quit from the tray menu. "Start with Windows" starts it hidden in the tray at sign-in.

Build it once with the C# compiler that ships with Windows (nothing to install):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File app\build.ps1
```

`dshgate.exe` must stay in this folder, next to `bin\dshgate.js`. It needs Node.js on the PATH.

## Set up from the command line

```powershell
npm ci --ignore-scripts
node bin/dshgate.js login claude        # also: codex, antigravity, kimi
node bin/dshgate.js key set deepseek    # the key is read from standard input
node bin/dshgate.js start               # keep this window open
```

In a second window:

```powershell
node bin/dshgate.js dsh apply --dry-run   # shows what would change
node bin/dshgate.js dsh apply
```

Then restart DeepSeek Harness. The models appear under four providers: `dshgate-lanes`, `dshgate-claude`, `dshgate-openai` and `dshgate-compat`.

The first `start` or `login` downloads the CLIProxyAPI release named in [backend.lock.json](backend.lock.json) and installs it only if its SHA-256 matches.

## Commands

| Command | What it does |
|---|---|
| `start` | Runs the gateway on `127.0.0.1:8417` and the backend on `127.0.0.1:8418` |
| `status` | Shows accounts, API keys, each lane's ladder and the DeepSeek Harness state |
| `login <provider>` | Signs in to a subscription with CLIProxyAPI's own login |
| `accounts` | Lists signed-in accounts |
| `key set <provider> [region]` | Saves an API key, encrypted |
| `key remove <provider>` | Removes a saved API key |
| `key list` | Lists API-key providers and their regions |
| `models` | Lists the models that can be offered right now |
| `dsh apply [--dry-run]` | Writes the models into every DeepSeek Harness profile |
| `dsh status` | Shows which dshgate routes each profile has |
| `dsh remove [--dry-run]` | Removes dshgate's routes from every profile |

## Lanes

The default ladders follow the model ladder in the DeepSeek Harness working defaults:

| Lane | Ladder |
|---|---|
| `lane-main` | `gpt-6-astra`, `claude-fable-5-2`, `gemini-4-carbon-high`, `deepseek/deepseek-v4-pro` |
| `lane-scout` | `claude-haiku-5-5`, `gemini-3.8-flash-high`, `deepseek/deepseek-flash`, `qwen/qwen3.8-flash` |
| `lane-builder` | `gpt-6-astra`, `claude-sonnet-5-5`, `deepseek/deepseek-v4-pro`, `gemini-4-argon-high` |
| `lane-architect` | `claude-fable-5-2`, `gpt-6.1-terra`, `deepseek/deepseek-v4-pro`, `gemini-4-argon-high` |
| `lane-reviewer` | `gemini-4-carbon-high`, `deepseek/deepseek-v4-pro`, `claude-opus-5-5` |

The reviewer ladder has no GPT model. The main and builder lanes start on GPT, and the gateway cannot check which model wrote the code under review.

Change the ladders under `lanes` in `~/.dshgate/settings.json`, then restart the gateway and run `dsh apply`.

### When a request moves to the next rung

| Upstream answer | What happens |
|---|---|
| HTTP 402, 429, 503 or 529 | The model sits out for 10 minutes (or for `Retry-After`, up to 6 hours). The request moves on. |
| HTTP 500, 502, 504 or no answer, three times in a row | Same as above. The first two are returned to the client. |
| A rejection saying the request is too long for the model | The request moves on. The model stays in use. |
| A rejection saying no signed-in account serves the model | The model sits out for 10 minutes. The request moves on. |
| Anything else, including every other HTTP 400 | The answer is returned to the client. |

A request never moves on because an answer looked weak. A rung with no account or API key is left out of the ladder. If every rung is sitting out, the whole ladder is tried anyway.

A conversation stays on the rung that last served it, so a recovered first rung does not pull it back mid-conversation. A conversation is identified by the `X-Session-ID` header, then `prompt_cache_key`, then its first user message.

Each response carries `x-dshgate-model` (the model that served it) and, for a lane, `x-dshgate-lane`.

A lane is declared to DeepSeek Harness with the smallest context window and output limit on its ladder, so a request sized for the lane fits every rung.

## What the gateway changes in a request

- The `model` field of a lane request becomes the rung that serves it.
- `ag-c55o-high` and `ag-c55s-high` are sent under the names Antigravity expects.
- A reasoning level the serving model does not accept is mapped to the nearest level it does accept.

A request that needs none of these reaches CLIProxyAPI byte for byte.

## What `dsh apply` writes

- The four `dshgate-*` routes inside the `llm-pi-ai` entry of each profile's `cordis.patch.yml`.
- A `DSHGATE_API_KEY` reference in `~/.dsh/.credentials.yaml`, if it is missing. DeepSeek Harness refuses a route whose key reference resolves to nothing; the gateway ignores the value.

It leaves every other entry, route and comment alone, including VeryCuteDroidProxy's `droidproxy-*` routes. It backs each profile up before changing it. Fields you add to a model entry, and its `input` list, are kept on the next sync.

It does not change the default model, the delegation lanes or `allowedModels`. To let subagents use a dshgate route, add it to `allowedModels` yourself.

`dsh remove` takes the four routes out again. If `dsh apply` had to add the `llm-pi-ai` entry itself, `dsh remove` takes that out too, unless you have since put other routes in it. The `DSHGATE_API_KEY` reference stays.

## Files

Everything is under `~/.dshgate` (override with `DSHGATE_HOME`):

| File | Contents |
|---|---|
| `settings.json` | Ports, lanes, and API keys in encrypted form |
| `master.key` | The key that encrypts the API keys, wrapped by Windows DPAPI for your account |
| `auth/` | Subscription credentials written by CLIProxyAPI |
| `backend-config.yaml` | The CLIProxyAPI configuration, rewritten on every start. **It holds your API keys in plain text**, because CLIProxyAPI reads them from there. |
| `bin/<version>/` | The installed CLIProxyAPI release |
| `dshgate.log` | The gateway log |

If `settings.json` exists but cannot be read, every command stops with an error and leaves the file as it is. Fix the file, or move it away to start from the defaults.

## New models and backend updates

**Models are found automatically.** About 3 seconds after start and then every 3 hours, dshgate reads which models the backend serves to your accounts and CLIProxyAPI's public model catalog ([models.router-for.me](https://models.router-for.me/models.json)) for each model's context size, output limit and reasoning levels. A current-generation chat model that your accounts serve is offered without a dshgate update. Image models, older generations and models the catalog does not describe are hidden; switch any model on or off on the **Models** tab (saved as `models.extra` / `models.hidden` in settings.json). When the offered list changes, dshgate updates its routes in the DeepSeek Harness profiles that already have them (each backed up first) and asks you to restart DeepSeek Harness. Profiles you never applied dshgate to are not touched.

**Lanes are never changed for you.** When a newer version of a model on a lane appears (for example Fable 5.3 for Fable 5.2), the Models tab suggests it; nothing changes until you press **Use** and confirm.

**Backend updates.** Every 6 hours dshgate asks GitHub for the latest CLIProxyAPI release (no drafts or pre-releases). When one is newer, the app shows **Update...**. Updating:
1. downloads the release's Windows zip and checks it against the `checksums.txt` that release publishes (addresses outside the official release path are refused);
2. starts it on a spare loopback port with your accounts and sends one short request per signed-in service (an out-of-quota answer does not count against it);
3. only if that passes, switches `~/.dshgate/backend.lock.json` to it, keeps the version it replaces, and restarts the gateway (a few seconds offline).

If the new version will not start, dshgate goes back to the previous one by itself. **Roll back...** in the app, or `dshgate backend rollback` with the gateway stopped, returns to the previous version. The version shipped in the repo's `backend.lock.json` is the floor: an older update is ignored.

## Sign-in and limits

Sign-in and limits run through CLIProxyAPI's Management API, which the gateway switches on with a new random key every start (the backend keeps only a hash of it). The gateway never reads or sends a token itself:

- **Sign-in**: the backend creates the provider's sign-in link. The provider sends the browser back to a fixed address on this machine (port 54545 for Claude, 1455 for ChatGPT, 51121 for Gemini); dshgate listens there on loopback only while a sign-in is open, passes the address to the backend, and shows a confirmation page. The backend exchanges the code and saves the account. A sign-in left open expires after 5 minutes.
- **Limits**: the backend calls each provider's usage endpoint with the account's own token. ChatGPT, Claude and Gemini report limits; Kimi does not. Limits are read at most once a minute.
  - Claude: 5-hour and weekly, plus each per-model weekly limit the plan sets (for example "Weekly (Fable)" on team plans), read from the `limits` list in Claude's reply.
  - ChatGPT: the 5-hour window is always listed; plans that report none show "Not reported for this plan". Per-model limits are added when ChatGPT reports them.
  - Gemini: 5-hour and weekly for Gemini models and for Claude/GPT models served through Google.
- **Limit resets (ChatGPT)**: when ChatGPT offers free limit resets, the account card shows **Use a reset (n)**. The app lists the resets with their expiry, asks which one to use, and asks again before spending it. Each attempt carries its own request ID, so a retried request cannot spend a second reset. ChatGPT keeps the reset if nothing is used up. These are the same resets the Codex CLI offers; Claude and Gemini do not offer resets.

The Windows app reaches these through a control API on the gateway (`/dshgate/control/`). Each call needs the token in `~/.dshgate/control.token`, which is new every start, and calls that come from a web page are refused.

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

## Updating the backend

Edit `version`, the two `url` values and the two `sha256` values in [backend.lock.json](backend.lock.json). Take the checksums from `checksums.txt` on the CLIProxyAPI release page. The next `start` installs the new version.

## Tests

```powershell
npm test
npm run check
```

## Not included

Compared with VeryCuteDroidProxy, dshgate leaves these out:

- Factory Droid model sync, Factory modes and the Workstream manager
- A window, tray icon or installer
- Auto routing by task type, and routing by remaining quota or weekly pace
- Routing that uses the remaining limits (limits are shown, not yet used to pick a model)
- Voice and video generation
- The Claude `Anthropic-Beta` rewrite and the removal of old thinking blocks
