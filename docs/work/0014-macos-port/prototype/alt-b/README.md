# Prototype B: option (a), the DSHProxy window as a local web page

A clickable prototype of stage D option (a). In this design the gateway draws the window as a page on `127.0.0.1`. A small menu-bar item opens it, and a login item starts DSHProxy at login.

**Why "B".** Two agents built this prototype in parallel by mistake. The other version is `../index.html`, with its own README and screenshots one folder up. This version lives in `alt-b/` so neither overwrites the other. Compare them and keep one.

Synthetic data only: the accounts are `a@example.com` to `e@example.com`, and the limits, keys, balances and outputs are made up. The key field takes typing, but the value is cleared at once and never kept or shown.

## How to open

Open `index.html` in a browser by double-clicking it or with `open docs/work/0014-macos-port/prototype/alt-b/index.html`. Nothing to build or install.

The file is self-contained: inline CSS and JS, and a Content-Security-Policy (`default-src 'none'`) that blocks every network request. The only other files are the provider logos in `logos/`, copied from `app/logos/` with their licence notice `logos/SOURCE.md` (LobeHub Icons 2.7.0, MIT, trademarks of their owners). If a logo is missing, a lettered badge is drawn instead. The app mark is an inline SVG redrawn after the description in `app/icon/NOTICE.md`, a brass compass needle over a dark sea.

Window sizes: designed for 860×600 at minimum and for 1280×800. Below 760 px high the window switches to "short window" mode, as the Windows app does: smaller header and tile, hint line hidden, tighter padding. Below 1060 px wide the Models list drops its Service column, again as on Windows.

## What it shows

The striped bar at the top holds the **prototype controls**, which are not part of the design:

- **Menu bar (mock)**: opens the drawn menu-bar overlay.
- **Scenario**: Sample data / Empty: no accounts or keys / Gateway stopped / Gateway not answering / Gateway starting.
- **Update available**: shows or hides the backend update offer.
- **2 requests in flight**: whether Stop and Quit have requests to warn about.

Buttons with a dashed outline inside dialogs (for example "Simulate: signed in") are also prototype-only. They stand in for something that happens in the browser or the OS.

**Header (both workspaces)**

- App tile, "DeepSeekProxy", and the state chip: ● Running / ● Starting / ● Not answering / ● Stopped.
- The detail line for each state, and "Lowest limit: Claude 5-hour, 8% left" in the colour of that limit.
- **Apply to DeepSeek Harness**, **Start** and **Stop**. Start is enabled only when the gateway is stopped; Stop is disabled only then.
- Start goes Starting → Running after about 1.6 s.
- Stop with requests in flight asks first. The safe answer is lit and focused, and Escape gives it. The not-answering variant has its own text.

**Backend update bar**

- "CLIProxyAPI 6.7.2 is available (you run 6.6.80), released …".
- **Update…** asks with the three-step text, shows "Downloading and trying…", reports the trial-run checks, then restarts.
- After the update the bar reads "Running CLIProxyAPI 6.7.2. The previous version 6.6.80 is kept." and offers **Roll back…**, which asks first and then restarts.

**Workspace switch and section pills**

- Chat / Video is a radio group: arrow keys switch it.
- The hint line changes with the workspace and the section.
- Six section pills (Accounts, API keys, Lanes, Models, DeepSeek Harness, Log) form a tablist. Left, Right, Home and End move between them, and the section is kept when the workspace changes.

**Chat › Accounts**

- One card per account: logo, label, e-mail, plan chip (shortened past 16 characters), Primary chip, ● Active / ● Paused.
- One limit bar per window. Bars are green, amber at 30% left or less, red at 10% or less. Each has "n% left · resets in … (today|tomorrow|day date HH:mm)". Windows a plan does not report show "Not reported for this plan".
- Pause and Resume, with the Paused note.
- Make primary and Not primary, shown only when a provider has two accounts.
- **Sign out…** asks first, with the Windows text.
- ChatGPT's red reset strip, "⚠ 2 limit resets". **Use a reset…** opens the danger-zone dialog: banner, the current windows, a radio per reset credit, and "Type RESET to confirm:". **Use this reset** stays disabled until the box holds exactly `RESET` (it is case-sensitive), and Cancel is the lit default.
- "Kimi does not report its limits."
- **+ Add account** walks the whole flow:
  1. Pick a service (Claude, ChatGPT (Codex), Gemini (Antigravity), Kimi).
  2. "Asking the provider for a sign-in link…".
  3. "Your browser opened" (a toast; nothing is opened). Browser services show the instruction to sign in; Kimi shows a device code with Copy code. Cancel, Copy link and Open page again are offered here.
  4. Simulated success, "✓ Signed in to …" with **Done** and **Add another**, or simulated failure with **Close**, **Back** and **Try again**.
- **Refresh limits** and **Open credentials folder** (Finder; mocked), plus the "Limits updated…" note.

**Chat › API keys**

- Provider / Region / State list with logos. States are Saved, "Saved, cannot be read: add it again" and Not set.
- **Add or replace key** opens a dialog whose key field is a labelled password field, with **Save** and **Cancel**. Saving offers "Restart the gateway now so it uses the change?". With requests in flight, the **Restart gateway** wait dialog counts them down, can be cancelled, then restarts.
- **Remove selected** asks first.

**Chat › Lanes**

- Routing buttons: Max performance / Balanced / Cheap production / Custom. The active one is lit, and its summary is the tooltip and the note.
- Choosing a preset asks first, then rewrites the ladders. Cheap production, for example, drops GPT and Opus.
- Custom explains that ladders are edited in settings.json, and marks the lanes Custom.
- Six ladders drawn as chips joined by "›": ✓ can serve, ⏸ sitting out until HH:mm, ✗ no account or key, with the name greyed. Screen readers get the state as text.
- **Edit lanes (settings.json)** opens settings.json in a text editor (mocked).

**Chat › Models**

- "Newer model: claude-fable-5-3 could replace claude-fable-5-2 on lane main, architect." **Use claude-fable-5-3** asks first, then replaces it in the ladders.
- Switches (`role="switch"`) per model. Columns: Model, Service, Context, Output, Reasoning, Status. Status texts include "NEW · found automatically" in brass and "Offered (you switched it on)".
- **Check for new models**, **Show hidden models** (which reveals the Hidden: … rows), and "Last checked … ago".

**Chat › DeepSeek Harness**

- Profile / Routes / Models / "Points at this gateway". Values are Yes, "No: apply again" and Not applied.
- A **video tools plugin status** line. This is an addition the brief asked for; on Windows it appears only on the Video page.
- **Preview changes** shows the dry-run output.
- **Verify** gives an Information or Warning box with per-profile lines.
- **Remove from DeepSeek Harness** asks first, then shows the output.
- The header's **Apply to DeepSeek Harness** opens the checklist dialog (✓ in place, → to do), then **Apply**. Next comes "Quit DeepSeek Harness to install the video tools", with **Skip the video tools** and a simulated quit. Last is the result dialog ("DeepSeek Harness is set up" / "The video tools were not installed") with the output lines, **Copy folder path** and **OK**.

**Log (shared)**

- Monospaced, focusable, scrollable log. Sample start-up lines, then a new synthetic line every 2.6 s while the gateway runs (a "Live" dot).
- Every action in the prototype appends its log line.
- **Open data folder** (mocked).

**Video › Accounts**

- The Krea workspace row: billed in workspace compute units; state "Signed in · until …" or "Not signed in".
- **Sign in to Krea…** leads to Signing in…, with **Cancel** enabled. Prototype buttons give consent or refuse.
- **Sign out** asks first.
- Status line "State read from the Krea helper at …".

**Video › API keys**

- VideoRouter, KovAPI and Callirra, with Environment variable / Billed in / State. States include "Saved, cannot be read: enter it again · also set in the environment".
- **Add or replace key…** opens a password field validated locally: not empty, at most 512 characters, printable ASCII without spaces. The error is shown inline and announced.
- **Remove key** asks first. A note says the Krea route uses a sign-in.

**Video › Lanes**

- Enabled models with Company logo / Billing route / Billed in, including "Not configured" and "Choose a billing route".
- **Change billing route…** opens the route dialog: a drop-down "Label · route · billed in units", and **Save route** stays disabled until a route is chosen.
- **Reload video settings**, plus the "Saved: … This is a setting only; nothing was checked or charged." line.

**Video › Models**

- Switches per model, with State Off / Enabled / No valid route.
- Switching on a model without a route opens the route dialog first.

**Video › DeepSeek Harness**

- The four rows: tools installed?, enabled with a route, enabled without a valid route, and tools found in this folder.
- "Checked at …". No buttons, as on Windows.

**Empty states**

- No accounts: the empty card with **+ Add account**.
- No keys: a teal note above the all-"Not set" lists (Chat and Video).
- No models: an empty card telling the user what to do.

**Error states**

- Gateway stopped, starting or not answering: Accounts shows the Windows message in place of the cards, with **Start** when stopped.
- Every other page shows a banner that says so and what still works, with **Start**.
- Actions that need the gateway answer "Start the gateway first.".

**Menu bar (mock)**

A dimmed overlay with a drawn macOS menu bar: the frontmost app's menus, status glyphs, the DSHProxy template icon and the clock. Under the icon hangs its menu:

- "DSHProxy: running" as a status line
- Open DSHProxy
- Add account…
- Start gateway
- Stop gateway
- ✓ Start at login (a `menuitemcheckbox`, tied to the footer check box)
- Quit ⌘Q

The arrow keys, Home and End move through the items, and Escape closes the overlay. **Quit** asks first when requests are in flight, then shows a "DeepSeekProxy has quit" screen with a prototype relaunch button.

**Footer**

- "Data: ~/.dshproxy · Program: ~/DSHProxy · Build: …". These paths are made up.
- **Start at login** check box (the Mac's equivalent of "Start with Windows"). It is mocked with a toast.

## What is mocked

- **No gateway, server or network.** Start, Stop, restarts, update and rollback are timers over in-memory state. Ports 8417 and 8418 appear only as text.
- **The OS: browser, Finder, text editor, login item, clipboard.** "Opened in your browser", "Would open … in Finder" and "Start at login is on (mocked)" are toasts. Copy code, Copy link and Copy folder path change their label but copy nothing.
- **All command output.** The texts for dsh apply, verify and remove, the trial-run checks and the Krea helper are invented, in the shape the inventory describes.
- **The menu-bar item and its menu.** They are drawn, because a web page cannot draw in the real menu bar.
- **Timing.** Sign-in, Krea consent and "DeepSeek Harness has quit" are driven by the dashed prototype buttons, not by polling.

## Inventory items not shown, or shown differently

Not shown:

- Command-line arguments (`--hidden`, `--preview`, `--preview-limits`, `--tab`, `--workspace`), single-instance handling and the second-launch "show" event (inventory 1.1–1.2).
- Live resizing behaviour (1.3). Only the two layouts (normal and short window) are shown, through CSS.
- The "Status unavailable" chip after three failed statuses (1.4).
- The "still running" notification on the first window close, and closing the window itself (1.9–1.10). In option (a) closing the browser window just closes the page.
- Restart-for-key-change outcomes other than "restarted" and "cancelled": exit 2 after 5 minutes, "could not be asked to wait", and the late-stop watch (1.11).
- These failure paths: update failure, "Could not read limits", "No limit reset is available", reset not confirmed, "Model catalog not reachable", error boxes for failed control calls, and the video key refusal-message redaction.
- Apply-flow bundle states other than "installed and open, tools not installed" and "tools already installed": not found, never opened, other folder, folder missing, unreadable, switched off, and the Cannot (✗) and Note (!) lines.
- Krea "Not known" / "Not read yet", and the video "Reading…" / "Not available" placeholders.
- Screen-reader announcements of status lines are partly covered by `aria-live` regions; the Windows UI Automation notifications are not reproduced as such.

Shown differently:

- **Chat API keys.** The Windows Provider drop-down is replaced by picking the row (radio). The Region drop-down follows the selected row. **Remove selected** is disabled when the provider has no key.
- **Lanes.** A **Custom** button sits beside the three presets, as the brief asked. Windows only shows a "Custom ladders…" note.
- **The preset question** says "every lane" instead of "all five lanes". The README lists six lanes while the Windows text says five; one of the two needs fixing.
- **Menu-bar menu.** Items are never greyed out, as on Windows (inventory 6.7). A status line was added at the top in place of the tray tooltip.

## Verification done (2026-11-23)

These checks used playwright-cli 0.x at `/opt/homebrew/bin/playwright-cli`, with its default Chromium (headless). By default playwright-cli refuses `file://` URLs, so the session was opened with `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1`. The scripts are in `checks/` and run with `playwright-cli -s=<session> run-code --filename=checks/walk.js` (and `checks/a11y.js`).

1. **Walkthrough, `checks/walk.js`.** It clicks through every page of both workspaces and every dialog listed above, at 1280×800 and at 860×600, saving 48 screenshots per size into `screenshots/` (96 in all). Results:
   - Console and page errors: none.
   - Horizontal overflow (any element past the viewport edge, or the page scrolling sideways): none, on every page at both sizes.
   - The reset button is disabled at open, still disabled with `reset`, and enabled with `RESET`.
   - The key field's `type` is `password`.
   - ArrowDown in the menu-bar mock moves focus; Escape closes it.
2. **Visual review.** I read the screenshots myself and fixed what I found:
   - The menu-mock caption covered the Quit item; it now sits bottom-left.
   - The prototype bar wrapped to two lines at 860 px; it now fits one.
   - The lanes legend is hidden in short windows.
   - The toast now sits over the footer instead of the action row.
3. **Keyboard and semantics, `checks/a11y.js`.**
   - The Tab order runs: prototype controls → Apply → Stop → Update… → workspace switch → section pills → card buttons in reading order → page actions → Start at login. Each element showed a visible focus ring; the check reads the computed outline or box-shadow.
   - Left and Right on the section pills switch pages; End goes to Log. Arrow keys switch the workspace.
   - Dialogs: focus stayed inside the Add account dialog for 12 Tab and 4 Shift+Tab presses, and inside the reset dialog for 10 Tabs. Escape closed each one and returned focus to the button that opened it. Yes/No boxes open with the safe answer focused, and Escape on Sign out keeps the account.
   - On every page, the key dialog, the reset dialog and the menu mock:
     - no duplicate ids;
     - no unlabelled input or select;
     - no button without a name or a `type`;
     - every image has `alt`;
     - nothing clickable that is not a `<button>`;
     - every `aria-labelledby` and `aria-describedby` has its target.

     Result: no issues.
   - Contrast of the text tokens against the dark surface (#0A1D26), computed by WCAG formula: text 16.6, muted 10.3, faint 6.3, green 10.1, amber 10.3, red 6.5, brass 8.9, ink on brass 9.4, white on the reset red 5.2, disabled 4.6.
4. **axe was not run.** axe-core is not installed anywhere on this Mac and not in the npm cache, and installing packages was out of scope. The keyboard and semantic checks above stand in for it; they are not equivalent.

## Not verified

- Safari and WebKit, which a Mac user would use, and Firefox. Only headless Chromium was used. `backdrop-filter`, `color-mix`, `<dialog>` and `mask-composite` are supported in current Safari, but this was not checked.
- VoiceOver, or any screen reader. Retina and high-DPI rendering. A real window being resized between the two sizes. `prefers-reduced-motion` (the rule exists but was not exercised).
- Serving from `127.0.0.1`. The file was opened as `file://`.
- Anything about the real gateway, control API, Keychain, login item or menu bar.

## Open questions this prototype raises for option (a)

1. **Who serves the page when the gateway is stopped?** The error state assumes the page stays up and offers Start. If the gateway itself serves the page, a stopped gateway means the browser shows a connection error, and Start lives only in the menu-bar item. A small always-on UI server, or the menu-bar item serving the page, would avoid that.
2. **The control API refuses any request with an `Origin` header** (inventory section 3, README "Sign-in and limits"). A page served by the gateway sends one, so option (a) needs a new, deliberate authentication design for the page, for example a token handed over by the menu-bar item plus a same-origin check.
3. **Five lanes or six?** The preset text says five; the README lists six.
