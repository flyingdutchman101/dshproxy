# Prototype: the DSHProxy window as a local web page (option a)

A clickable prototype for decision 4 of the [spec](../spec.md). It shows option (a): the window is a web page served on 127.0.0.1, opened from a small macOS menu-bar item, with a login item for starting at login. It is not production code, and nothing in it talks to the gateway.

- **File:** `index.html`. One file with inline CSS and JS, no external requests and no build step. Lettered badges stand in for the logos.
- **Data:** synthetic and held in memory only (`a@example.com` … `f@example.com`, fake key text, made-up limits and versions). A reload resets everything.
- **Yardstick:** [research/app-inventory.md](../research/app-inventory.md). Its colours (page `#02101A`, brass `#E4B26A`, teal, ok/warn/bad) and its texts are used where they exist.

## How to open

Open `index.html` in any browser: double-click it, or run `open docs/work/0014-macos-port/prototype/index.html`. It works from `file://` and needs no server. The layout is designed for 860×600 at minimum and for 1280×800.

The strip at the top marked **PROTOTYPE** is not part of the product. Use it to:
- set the gateway state (Running, Starting, Not answering, Stopped);
- switch between the Sample data and an Empty first-run data set;
- open **Menu bar (mock)**.

## What it shows

**Header**
- State chip (Running, Starting, Not answering, Stopped), detail line and "Lowest limit" line.
- **Apply to DeepSeek Harness**, **Start** and **Stop**. Stop asks first when requests are in flight or the gateway is not answering; the safe button has focus.
- Backend bar: **Update…** asks, shows "Downloading and trying…", then shows the trial-run result and a restart (Starting, then Running). After that the bar reads "previous version kept" with **Roll back…**.
- Chat/Video workspace switch (a radio group: arrow keys work) and section pills (a tablist: ←/→/Home/End work). The hint line is hidden at narrow widths, as in the Windows app.

**Chat**
- **Accounts:**
  - Cards with plan, Primary, Active/Paused chips and limit bars (amber below 30%, red below 10%, with the reset time).
  - **Make primary**, **Not primary**, **Pause**/**Resume**, and **Sign out…** with a confirmation.
  - "Not reported for this plan" rows, the paused note, and the "Kimi does not report its limits." note.
  - ChatGPT reset strip → **Use a reset…** dialog: danger banner, current limits, a radio per credit, and "Type RESET to confirm". The button stays disabled until the trimmed text is exactly `RESET`. Using a reset fills the limits and removes the credit.
  - **+ Add account:** pick a service → "Asking…" → "Your browser opened" (a device code for Kimi, with Copy code) → success ("✓ Signed in", Done / Add another) or failure (Close / Back / Try again). Dashed "Simulate…" buttons stand in for the browser.
  - **Refresh limits** and **Show credentials in Finder**.
- **API keys:**
  - One row per provider, with region and state (Saved / Saved, cannot be read / Not set).
  - Add/Replace dialog with a password field, a Show toggle, a region select where the provider has regions, and Save disabled while empty.
  - Remove with a confirmation.
  - After a change the dialog asks "Restart the gateway now?". **Restart now** with requests in flight shows the waiting dialog ("Waiting for 2 requests…", Cancel), then restarts.
- **Lanes:**
  - Routing presets **Max performance / Balanced / Cheap production**, with confirmation. Their ladders are copied from `src/presets.js`.
  - **Custom** becomes active after **Edit lanes (settings.json)** (pretend edit) or after using a model suggestion.
  - Ladders show ✓ / ⏸ / ✗ chips with names joined by ›. A chip's state follows the accounts and keys: pause or sign out an account and its models turn red.
- **Models:**
  - On/off switches and the status texts from the inventory.
  - "Newer version" suggestion with **Use claude-opus-5-6**, which replaces it in the ladders after confirmation.
  - **Check for new models**, **Show hidden models**, and "Last checked".
- **DeepSeek Harness:**
  - Profiles table (Yes / No: apply again / Not applied).
  - **Preview changes**, **Verify** (result dialog) and **Remove from DeepSeek Harness** (confirmation).
  - Video-tools plugin status, with a link to Video › DeepSeek Harness.
  - Header **Apply** shows a checklist dialog (✓ → !), a busy state, then the result dialog ("DeepSeek Harness is set up", output lines, Copy folder path).
- **Log:** a monospace log with live-looking request lines added every 2.6 s while the gateway runs, plus **Show data folder in Finder**.

**Video**
- **Accounts:** Krea row. **Sign in to Krea…** moves to "Signing in…" with a "Your browser opened Krea's consent page" panel. **Cancel** works only while signing in. Simulate approved/refused. **Sign out…** asks first.
- **API keys:** VideoRouter, KovAPI and Callirra, with environment variable, billed-in and state ("· also set in the environment"). Add/replace includes the local check (≤ 512 printable characters; an error is shown in the dialog). Remove asks first.
- **Lanes:** billing route per enabled model, "Not configured" / "Choose a billing route", and **Change billing route…** (route dialog; Save is disabled until a route is chosen). **Reload video settings**.
- **Models:** switches. Switching on a model without a route opens the route dialog first. States are Off / Enabled / No valid route.
- **DeepSeek Harness:** the four What/State rows and "Checked at".

**States**
- **Gateway not running:** Accounts, Lanes and Models show a panel that says so, with **Start the gateway**. API keys and DeepSeek Harness show a banner with Start; keys can still be saved. Starting shows a spinner, and Not answering has its own text.
- **Empty first run:** no accounts, no keys, no models found, no profile, no video model enabled.

**Menu bar (mock)**
- A drawn macOS menu bar with the DSHProxy item. Its dot is the gateway state.
- The menu reads "DSHProxy: running", Open DSHProxy, Add account…, Start gateway, Stop gateway, ✓ Start at login, Quit DSHProxy.
- ↑/↓ (disabled items skipped), Return and Escape work. Clicking outside closes it.
- Start at login is the same setting as the footer switch.
- **Quit** asks when requests are in flight, then shows a "DSHProxy has quit" screen.

**Accessibility built in**
- Real `<button>`s, labelled inputs, and per-account `aria-label`s ("Pause Claude b@example.com").
- Visible focus ring (2 px brass).
- Native modal `<dialog>` with an explicit Tab/Shift+Tab focus trap. Escape closes it and focus returns to the opener.
- Status changes announced through a polite live region.

## What is mocked

| Piece | What the prototype does | What a real build would do |
|---|---|---|
| Gateway | A state variable; Start takes 1.8 s | Start `bin/dshproxy.js start`, poll `/dshproxy/status` |
| All control calls | Change in-memory data and add a log line | `POST /dshproxy/control/...` with the control token |
| Browser sign-in, Krea consent | Dashed "Simulate…" buttons | Open the `https` URL in the default browser, poll `login/status` |
| Clipboard (Copy link / code / folder path) | Label changes to "Copied" | Write to the clipboard |
| Finder / text editor | A toast saying what would open | `open` the folder / `settings.json` |
| Login item | Toggles a flag | Register a login item (SMAppService or a LaunchAgent) |
| Menu-bar item | Drawn in HTML | Small native status item: the only native part of option (a) |
| Footer paths | Fixed text (`~/.dshproxy`, `/Applications/DSHProxy.app`, build stamp) | From `status --json` and the build |
| Log | Seeded lines plus synthetic request lines | Gateway stdout/stderr and app events |

### Assumptions to confirm

1. **Who serves the page when the gateway is stopped.** The prototype assumes a small window server on `127.0.0.1:8418` that stays up while the model gateway on `127.0.0.1:8417` is stopped. That is why the page can say "Stopped" and offer Start. If the gateway itself draws the page, a stopped gateway means no page at all. In that case only the menu-bar item can show "Stopped" and offer Start.
2. **Deliberate differences from the Windows app, for the user to accept or reject:**
   - The menu greys out Start/Stop gateway according to state (Mac convention). Windows never disables them (inventory §6.7).
   - Confirmations use "Cancel / <verb>" instead of Yes/No, with the safe button focused, as on Windows.
   - API keys have a button on every row instead of a provider drop-down plus "Remove selected". Region is chosen in the dialog.
   - Model "tick boxes" are switches.
   - "Open … folder" became "Show … in Finder".
   - Bars turn amber below 30% and red below 10%, as the brief and the note say. The Windows code colours at ≤ 30 / ≤ 10 (inventory §6.2).
   - The API-keys note says the unlocking key is in the macOS Keychain (decision 3 in the spec).

## Inventory items not shown

- §1.1–1.3: command-line switches (`--hidden`, `--preview`, `--preview-limits`, `--tab`, `--workspace`); single instance; window placement and minimum-size rules; the resize preview; the dark title bar. A browser tab has no equivalent of these.
- §1.4: the "Status unavailable" chip after 3 failed full statuses, and Starting → Not answering after 30 s (Not answering is reachable only through the prototype strip).
- §1.9–1.10: close-hides-window and the one-time "still running" notification. In option (a), closing the tab does not stop the gateway, so it has no counterpart yet.
- §1.11: restart outcomes other than success and Cancel: exit 2 "still running after 5 minutes", the "could not be asked to wait" question, and the late-stop watch. Stopping a gateway started by another window.
- §1.12–1.13: status polling cadence, log trimming, `dshproxy.log`.
- §2.1:
  - The "Reading limits…" / "Could not read limits" note is shown only briefly after Refresh.
  - A per-account `error` text.
  - The "No limit reset is available" and "reset not confirmed" failure messages.
  - The provider-list fallback.
- §2.1.1: sign-in expiry after 5 minutes; real polling; "Copy link" copying anything.
- §2.3: preset tooltips exist only as `title` attributes; there is no settings.json-missing message.
- §2.4: "Model catalog not reachable" note and the "Hidden: no details known" row; generic control-call error box.
- §2.5.1:
  - Bundle states other than Installed / Not installed (Switched off, Other folder, Folder missing, Never opened, Not found, Unreadable).
  - **HarnessWaitDialog** ("Quit DeepSeek Harness to install the video tools").
  - Result variants "not installed / left switched off / not checked".
  - The "And N more lines" cut-off.
- §2.7: most Krea outcome texts (only "Signed in to Krea." and one refusal are shown).
- §2.8: the refusal-message masking; the "cannot be read" video-key state exists in code but not in the sample data.
- §2.9–2.10: "Not allowed: {route}" (code path only); read failures ("Could not read the video settings"); placeholders "Not available" / "Reading…".
- §2.11: "Not available on macOS yet" for the plugin (inventory §6.13) is in code (`videoTools: "na"`) but not reachable from the UI.
- §3–4: control token, CLI commands, processes, files. None are touched.

## Checks done

Run with `/opt/homebrew/bin/playwright-cli` (Chromium, headless) against `file://…/index.html`. Playwright blocks `file:` by default, so it ran with `checks/cli.config.json` (`allowUnrestrictedFileAccess: true`). The scripts are in `checks/` and use this machine's absolute paths.

| Check | Command / script | Result |
|---|---|---|
| Script syntax | `node --check` on the extracted `<script>` | OK (one syntax error found and fixed) |
| Console errors | `playwright-cli console` after every run | 0 errors, 0 warnings |
| Screenshots | `checks/shots.js` (27 per size) + `checks/flows.js` (8 more) | 62 PNGs in `screenshots/` |
| Visual review | Read 16 of the PNGs (both sizes: accounts, lanes, models, keys, harness, video models/accounts, reset, sign-in, apply, restart wait, menu mock, stopped, empty) | Fixed: empty meter bars (invalid colour), "% left" not coloured, page-head notes squeezed at 860 px (actions now wrap), numeric headers misaligned, disabled "Custom" not dimmed |
| Click-through | `checks/flows.js` | 43/43 PASS: account actions, sign-in success/failure/retry, reset use, key save → restart wait → restart, key remove, presets, model switch, suggestion → Custom ladder, verify/preview/remove/apply, update → rollback, video key validation, route dialog, video model without route, Krea sign-out/in, live log, not-answering stop text, quit |
| Keyboard | `checks/keys.js` | Tab order: prototype strip → Apply → Stop → Update → workspace → section tab → page actions → card buttons in reading order → Start at login. Visible 2 px brass outline. ←/→ move the tabs. Dialogs: initial focus on the safe button (or the RESET field); Tab and Shift+Tab stay inside; Escape closes and returns focus to the opener. RESET button disabled for "" and "reset", enabled for " RESET ". Menu mock: ↓ skips disabled items; Escape closes and returns focus. |
| DOM audit (own script, not axe) | `checks/dom.js`, every page of both workspaces, 6 dialogs, menu mock, all gateway states, empty data, at 1280×800 and 860×600 | Every control has a name, every input a label, no duplicate ids, no dangling aria references, no horizontal overflow, no clipped button text. Fixed: two stale-dialog issues (duplicate id, dangling `aria-labelledby`). |

## Checks not done

- **axe-core**: not installed in the project or globally, and not installed for this, as instructed. Accessibility is covered only by the keyboard check and the DOM audit above.
- No screen reader (VoiceOver) pass. No colour-contrast measurement.
- Only Chromium; not Safari/WebKit or Firefox.
- 46 of the 62 screenshots were generated but not looked at one by one.
- No real macOS menu bar, login item, browser opening or clipboard.
- Timing-dependent screens (marquee, spinners) were captured at one moment only.
- Mobile widths: not relevant (the minimum is 860×600).

## Files

- `index.html`: the prototype.
- `README.md`: this file.
- `screenshots/`: `{1280|860}-{page or state}.png`.
- `checks/`: playwright-cli `run-code` scripts (`shots.js`, `flows.js`, `keys.js`, `dom.js`) and `cli.config.json`.

`logos/` and `alt-b/` in this folder were not made by this prototype. They appeared while it was being built and were left untouched.

The scripts in `checks/` name the checkout as `__REPO__`; replace it with the path of your checkout before running them. Screenshots are not committed (`.gitignore`); the scripts make them again.
