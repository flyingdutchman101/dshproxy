# Prototype: the native macOS app (menu-bar item + SwiftUI window)

A clickable prototype of the macOS app built the DroidProxy way: a Swift menu-bar app (`LSUIElement`, no Dock icon) with a SwiftUI window that holds the same pages as the Windows app. It is not production code.

**What it does not do:** it starts no gateway, runs no `node`, opens no socket, touches no Keychain, registers no login item and writes no file outside `build/`. All data is synthetic and in memory (`a@example.com` … `f@example.com`, made-up limits, versions and key states), taken from the accepted web prototype [`../prototype/index.html`](../prototype/index.html). Quitting resets everything.

## Build and open

Needs only the Command Line Tools (tested: Swift 5.10, SDK 14.4, arm64). No Xcode, no SwiftPM, no packages, no network.

```sh
cd docs/work/0014-macos-port/prototype-native
./build.sh                         # makes build/DSHProxy Prototype.app (ad-hoc signed)
open "build/DSHProxy Prototype.app"
```

- `build.sh` runs `swiftc -parse-as-library -target <arch>-apple-macos13 -O` on `Sources/*.swift`, has the binary draw its own icon (`--write-iconset`, then `iconutil`), writes `Info.plist` (`LSUIElement` true, bundle id `com.dshproxy.prototype`, macOS 13+) and signs with `codesign --force --sign -`.
- `./build.sh --render` also runs the review render mode into `build/render/`.
- `build/` is git-ignored (`.gitignore`).
- The window opens at launch. `--hidden` starts with the menu-bar item only.
- Quit from the menu-bar item (**Quit DSHProxy**, ⌘Q). Closing the window only hides it.

### Review render mode

```sh
"build/DSHProxy Prototype.app/Contents/MacOS/DSHProxyPrototype" --render build/render
```

This writes 90 PNGs and exits. It shows no window and no Dock or menu-bar item, and takes about 50 s.

**ImageRenderer does not work for this app.** SwiftUI `ImageRenderer` on macOS draws every AppKit-backed control as a yellow "prohibited" placeholder: Button, Toggle, Picker, TextField, ProgressView, Gauge, ScrollView content, **and List and Table alike**. Switching to List would not help. See `--render-imagerenderer build/imagerenderer`, which writes `imagerenderer-chat-accounts.png` as evidence. The render mode therefore uses a different method:
- It puts each view in an `NSWindow` that is never ordered front and draws it with `NSView.cacheDisplay(in:to:)`. That needs no screen-recording permission and puts nothing on screen.
- Offscreen windows normally draw in the *inactive* look (grey default buttons). The render-only subclass `OffscreenWindow` answers AppKit's private active-appearance selectors, so the PNGs show the active look. The app itself never uses that class.
- Alerts are real `NSAlert`s, laid out with `layout()` and drawn the same way. They keep the inactive look, so their default button is not blue.
- The menu-bar menu cannot be drawn offscreen. `menubar-menu-*.png` is a SwiftUI drawing made from the same `menuEntries()` list that builds the real `NSMenu`.

PNG names: `1280-*` and `860-*` are whole windows (title bar included) at 1280×800 and 860×600, at 2× scale. `1280-dark-*` use Dark Mode. `sheet-*`, `alert-*` and `menubar-*` are drawn at their natural size.

## What it shows

**Menu-bar item** (NSStatusItem + NSMenu, as in DroidProxy's `AppDelegate.swift`)
- **Icon** (`StatusIcon.swift`): a template image (a compass needle in a ring) that changes shape with the gateway state:
  - running: solid;
  - starting: dashed ring;
  - not answering: "!" badge;
  - stopped: hollow needle with a slash.

  Its tooltip and VoiceOver label are "DSHProxy: running" and so on.
- **Menu**, in this order:
  - status line;
  - Open DSHProxy (⌘O);
  - Add account…;
  - Start gateway / Stop gateway (only the one that applies is enabled);
  - Start at login, a check mark that only flips a flag;
  - **Prototype** submenu (marked "Not part of the product"): simulate Running, Not answering or Starting, and load the sample data or empty first-run data;
  - Quit DSHProxy (⌘Q).
- **Stopped gateway:** the window only says so and points to the menu-bar item, with a small drawing of the icon and "Start gateway". There is no Start button in the window (the user's decision). **Start gateway** in the menu shows Starting, then Running after 1.8 s.
- **Stop** and **Quit** ask first when requests are in flight (2 in the sample) or the gateway is not answering. The texts are the Windows ones, and Cancel is the default button.
- **Add account…** with the gateway stopped asks to start it first ("Start the gateway first. Sign-in runs through it.").

**Window** (NSWindow + NSHostingView)
- **First size and minimum size:** opens at up to 1280×880 (92% of the screen at most) on the screen under the pointer. The minimum is 860×600.
- **Header:**
  - app mark, name and state chip;
  - detail line ("http://127.0.0.1:8417 · CLIProxyAPI 6.9.2 · 5 accounts · 17 models offered");
  - "Lowest limit", coloured by threshold;
  - **Apply to DeepSeek Harness** (prominent) and **Stop**.
- **"Short window" mode** below a height of 700: smaller mark and tighter paddings, as the Windows app does below 760.
- **Backend bar:** **Update…** (confirm, then "Downloading and trying…", then the trial-run result, Starting, Running). After an update the bar reads "previous version kept" and offers **Roll back…** (confirm, then restart).
- **Navigation:**
  - The Chat/Video switch and the section tabs are segmented controls.
  - They share one row when the window is wide. At narrow widths the tabs move to a second row and the hint line stays beside the switch.
  - Keyboard: ⌘1–⌘6 pick a section; ⌥⌘1 and ⌥⌘2 pick Chat or Video.
- **Footer:** the Data / Program / Build line and a **Start at login** check box. It is the same fake flag as the menu item.
- **Notices:** a short message at the bottom of the window (for example "Paused Claude (b@example.com).") that goes away after 4 s. It is also sent to VoiceOver as an announcement.

**Chat › Accounts**
- One card per account:
  - letter badge, label, e-mail;
  - plan chip, Primary chip, Active/Paused chip;
  - **Not primary** / **Make primary**, **Pause** / **Resume**, and **Sign out…** (red; confirmation alert with the Windows text).
- **Limit rows:**
  - Each row is a native `Gauge` (linear capacity) with "64% left · resets in 2 h 12 min (tomorrow 01:17)".
  - Bars are amber below 30% and red below 10%.
  - "Not reported for this plan" for rows without a value.
  - The paused note and the "Kimi does not report its limits." note.
- **ChatGPT reset strip:** "⚠ 2 limit resets", "Danger zone…", and **Use a reset…**, which opens the reset sheet:
  - danger banner and current limits;
  - radio group of credits;
  - "Type RESET to confirm" text field. **Use this reset** stays disabled until the trimmed text is exactly `RESET`.
  - Using a reset fills the limits, removes the credit and shows a result alert.
- **Add account…** opens a sheet with these steps:
  - pick a service (4 tiles);
  - "Asking … for a sign-in link...";
  - "Your browser opened": instructions, or the Kimi device code with Copy code; an indeterminate bar; Cancel and Open page again;
  - success ("✓ Signed in", Done / Add another) or failure (Close / Back / Try again).
  - Buttons marked "Simulate…" stand in for the browser.
- **Refresh limits** and **Show credentials in Finder** (fake: shows a notice).
- **Empty first run:** "No accounts yet" with Add account….

**Chat › API keys**
- A `Table` with Provider / Region / State and one row per provider. States: Saved / "Saved, cannot be read: add it again" / Not set.
- Select a row, then **Add or replace key…** or **Remove…**. A double-click or the context menu does the same.
- **Key sheet:** a Region picker where the provider has regions, a `SecureField` (with a Show key check box), and Save, which stays disabled while the field is empty. Nothing typed is kept.
- After a save or remove, a "Restart gateway?" alert appears. **Restart now** with requests in flight opens the "Restart gateway" waiting sheet: it counts the requests down, and Cancel works. Then the gateway goes Stopped → Starting → Running.
- When the gateway is not answering or starting, a banner says that keys can still be saved.

**Chat › Lanes**
- Routing presets are a segmented picker: Max performance / Balanced / Cheap production, plus Custom when the ladders were edited. Picking a preset asks first. The ladders are those of the web prototype.
- Each lane is a `List` row, with chips joined by "›" that wrap with the window width. Each chip shows ✓ (green, can serve), ⏸ (amber, sitting out) or ✗ (red, no account or key) and has a tooltip and a VoiceOver label ("gpt-6.1-terra: sitting out after running out of quota, back in 23 min").
- Chip states follow the accounts and keys.
- **Edit lanes (settings.json)…** pretends an edit, so the routing turns Custom.

**Chat › Models**
- A `Table` with an Offer check box, Model, Service, Context, Output, Reasoning and Status (the Windows status texts).
- "Newer version" suggestion: **Use claude-opus-5-6** asks first, then replaces the model in the ladders and the routing turns Custom.
- **Show hidden models**, **Check for new models** ("Checking…") and "Last checked".

**Chat › DeepSeek Harness**
- Profiles `Table`: Yes / "No: apply again" / Not applied.
- **Preview changes…** and **Verify** open output sheets. **Remove from DeepSeek Harness…** asks first, then shows an output sheet.
- Video tools (plugin) status, with **Open Video › DeepSeek Harness**.
- The header **Apply** opens a checklist sheet (✓ → ! marks), then "Writing the routes…", then the result sheet with the output and Copy folder path.

**Log** (shared by both workspaces): monospaced, selectable lines. Live-looking request lines are added every 2.6 s while the gateway runs. **Show data folder in Finder** (fake).

**Video**
- **Accounts:** Krea row in a `Table`.
  - **Sign in to Krea…** shows "Signing in..." and a "Your browser opened Krea's consent page" panel with a progress bar and Simulate approved/refused buttons.
  - **Cancel** is enabled only while signing in.
  - **Sign out…** asks first.
- **API keys:** VideoRouter, KovAPI and Callirra, with environment variable, billed-in and state ("· also set in the environment"). The key sheet runs the local check: at most 512 printable characters, no spaces. The error is shown in the sheet.
- **Lanes:** billing route per enabled model ("Not configured", "Choose a billing route"). **Change billing route…** opens a route sheet: a picker with "Choose a route…", and Save route, which stays disabled until a route is chosen.
- **Models:** On check boxes. Ticking a model without a route opens the route sheet first. States: Off / Enabled / No valid route.
- **DeepSeek Harness:** the four What/State rows and "Checked at".

**Accessibility built in:** system controls throughout; VoiceOver labels on per-account buttons ("Pause Claude b@example.com"), gauges (label + value), ladder chips, tables and pickers; header traits on titles; ⌘-shortcuts; Return/Escape on sheet buttons (`.defaultAction` / `.cancelAction`); Light and Dark Mode from the system.

## What is faked

| Piece | Prototype | Production (planned) |
|---|---|---|
| Gateway | A state variable; Start takes 1.8 s | `node bin/dshproxy.js start`, then poll `GET /dshproxy/status` |
| Control calls (accounts, presets, models, resets, update) | Change in-memory data and add a log line | `POST /dshproxy/control/…` with the control token |
| CLI commands (keys, dsh apply/verify/remove, video settings) | Fake output | Run `node bin/dshproxy.js …` |
| Browser sign-in, Krea consent | "Simulate…" buttons | Open the `https` URL, poll `login/status` |
| Clipboard (Copy code/link/folder path) | Label changes to "Copied" | `NSPasteboard` |
| Finder, settings.json | A notice | `NSWorkspace` |
| Start at login | A flag | `SMAppService` login item |
| Keys typed | Dropped on Save | Sent on stdin to `key set` |
| Footer paths, build stamp | Fixed text | From `status --json` and the build |
| Provider logos | Letter badges | The embedded logos (`app/logos`) |

## Inventory items left out

Compared with [`../research/app-inventory.md`](../research/app-inventory.md):

**Window and program (§1)**
- §1.1–1.2: `--preview`, `--preview-limits`, `--tab` and `--workspace`; single instance; finding Node and the program folder. Only `--hidden` exists.
- §1.3: re-checking the minimum size after a move to another screen; the resize preview; the dark title bar (the system look is used instead).
- §1.4: the "Status unavailable" chip; Starting → Not answering after 30 s. Not answering is reached through the Prototype submenu.
- §1.9–1.10: the one-time "still running" notification when the window is first closed; UI Automation announcements of the video status line.

**Gateway process and status (§1.11–1.13)**
- Restart outcomes other than success and Cancel (still running after 5 minutes, "could not be asked to wait", late-stop watch); a foreign gateway.
- Polling cadence; log trimming at 400,000 characters (the prototype keeps 300–400 lines).

**Pages (§2)**
- §2.1:
  - "Could not read limits", per-account `error` text;
  - "No limit reset is available", "reset not confirmed";
  - the provider-list fallback; sign-in expiry; real polling.
- §2.4: "Model catalog not reachable", "Hidden: no details known" rows (text exists, no sample row), the generic error box.
- §2.5.1:
  - bundle states other than Installed / Not installed;
  - **HarnessWaitDialog** ("Quit DeepSeek Harness to install the video tools");
  - result variants;
  - "And N more lines".
- §2.7: Krea outcome texts other than "Signed in to Krea." and one refusal.
- §2.8: refusal-message masking.
- §2.9–2.10: "Not allowed: {route}" (code path only); read failures; "Reading…" placeholders (only the status line changes).

**Below the UI (§3–4):** control token, CLI commands, processes, files, registry. None are touched.

## Differences from the Windows app (for the user to accept or reject)

1. **Start in the menu only.** Start lives only in the menu-bar item. While stopped, the window shows only a "gateway is stopped" message (the user's decision). The window header has **Stop** but no **Start**.
2. **Mac conventions:**
   - The menu enables only Start or Stop according to the state; Windows never disables them.
   - Confirmations are native alerts. The safe button (Cancel / Later) is the default (Return), as Windows defaults to No; the destructive button is red. Button order is AppKit's.
   - "Open … folder" became "Show … in Finder"; "Start with Windows" became "Start at login".
3. **API keys:** select a row in a native Table and use the buttons below (or double-click), instead of a provider drop-down plus "Remove selected". The region is picked in the key sheet.
4. **Look:**
   - The system look (Light/Dark, accent colour), not the dark brass "glass" skin.
   - Segmented controls stand in for the pill strip; check boxes for model ticks; `Gauge` for the limit meters.
   - Bars are amber below 30% and red below 10%, as the note says (the Windows code uses ≤).
5. **Short window and narrow layout:** short-window mode starts below a height of 700 pt rather than 760 px. The section tabs wrap to their own row when the window is narrow.
6. **API keys note:** it says that the unlocking key is in the macOS Keychain (spec decision 3).
7. **Not on Windows:** a Prototype submenu for state and data simulation. It must not ship.

## Checks done

| Check | Result |
|---|---|
| `./build.sh` (swiftc 5.10, SDK 14.4, arm64) | Builds with 0 errors and 0 warnings. `plutil -lint` OK. `codesign --verify`: "valid on disk", "satisfies its Designated Requirement". Signature=adhoc, Identifier=com.dshproxy.prototype, `LSUIElement` true. Bundle 2.8 MB. |
| `--render build/render` | Exit 0, 90 PNGs, nothing on screen. |
| Visual review (read about 30 PNGs: every page at 860, most at 1280, dark accounts, the stopped/starting/not-answering/empty states, 9 sheets, 2 alerts, menu drawing, icons) | Fixed after looking: Gauge printed its label above each bar; the nav row overflowed at 860 ("Workspace" and "Log" clipped), so the tabs now wrap to a second row; tables clipped their last row (row height 26, not 24); the Models Status column and the Video Models State, Video Lanes Billed-in and Krea Service columns truncated at 860; destructive buttons were not red, and a disabled one stayed red; offscreen renders were in the inactive look (prominent buttons grey); alerts showed a dashed placeholder icon (the app now has an icon); the route sheet overflowed to the left; the header was too tall for a 600-pt window (short-window mode added). |
| `--render-imagerenderer` | Placeholders confirmed for all AppKit-backed controls; the scrolling page content is blank. |
| RESET logic (render of the sheet with "", "reset", " RESET ") | Disabled, disabled, enabled. |
| Repository hygiene | `git status` shows only new files in this folder. `build/` is ignored (`git check-ignore`). |

## Checks not done

- **The app was not launched with its window on screen.** The user is using this Mac. Clicking, the real NSStatusItem, the real NSMenu, sheet presentation, alert sheets on the window, timers (Starting → Running, the restart countdown, the live log) and keyboard focus order were **not exercised**. Only the render mode ran. Everything interactive is compiled but untested.
- No VoiceOver pass and no Accessibility Inspector audit. The labels are in the code but were not heard.
- No colour-contrast measurement. Orange "amber" text on light backgrounds may be low-contrast.
- Not tested on Intel (`build.sh` uses `uname -m`) or on macOS 13/14/15. Built and rendered on macOS 26.6 only.
- About 60 of the 90 PNGs were generated but not looked at one by one (mostly the 1280 counterparts, the remaining alerts and some sheets).
- Known small left-overs seen in the PNGs:
  - "workspace compute u…" truncates in Video › Models at 860 (the column can be resized);
  - a wrapped ladder line starts with "›";
  - alert default buttons draw grey offscreen.
- Not done at all: no independent review, no unit tests (the prototype has no logic worth testing apart from the RESET rule and the key check, which were checked by render only), no Gatekeeper / notarisation (ad-hoc signature only; on another Mac it would need right-click › Open).

## Files

- `build.sh`: builds and signs the app, optionally renders.
- `Sources/Main.swift`: entry point and command-line switches.
- `Sources/AppDelegate.swift`: status item, menu, window, NSAlert presentation, key shortcuts.
- `Sources/StatusIcon.swift`: menu-bar icon drawing and the menu as data.
- `Sources/Model.swift`: catalogue, synthetic data sets, formatting.
- `Sources/Store.swift`: state and every (fake) action, alert texts.
- `Sources/RootView.swift`: header, update bar, navigation, footer, stopped view.
- `Sources/ChatPages.swift`, `Sources/VideoPages.swift`: the pages.
- `Sources/Sheets.swift`: all sheets.
- `Sources/Components.swift`: chips, badges, gauge rows, flow layout, small helpers, app-icon art.
- `Sources/Render.swift`: offscreen render mode, icon writer, ImageRenderer demo, menu drawing.
- `.gitignore`: ignores `build/`.
