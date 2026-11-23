# Stage D — the app on macOS: criteria and plan

Status: draft, written on the Mac on 23 Nov after decision 4 (**a native app, built like DroidProxy**; spec, decisions). Not reviewed. **Production code waits until the user has seen the native prototype** (`prototype-native/`, being built) and this document.

Yardstick: `research/app-inventory.md` (every page, button, dialog and control route of the Windows app, with file:line). Facts: `research/facts.md` section 9.

## What the user gets

`DSHProxy.app`: an icon in the menu bar (no Dock icon), a window with the pages of the Windows app (Chat: Accounts, API keys, Lanes, Models, DeepSeek Harness, Log; Video: Accounts, API keys, Lanes, Models, DeepSeek Harness), the gateway kept running while the window is closed, Quit in the menu, and Start at login.

## How it is built (to be confirmed by the prototype and the facts below)

- A Swift package in `app-macos/` with three targets: `DSHProxyKit` (no UI: finding Node and the checkout, starting and stopping the gateway, the status and the control API client, the CLI calls the Windows app makes), `DSHProxyApp` (SwiftUI: menu bar and window), `KitChecks` (an executable that checks `DSHProxyKit`; XCTest is not in the Command Line Tools on this Mac, so the checks are a program of their own that runs here and in CI).
- `app-macos/build.sh` builds with `swift build -c release` (no Xcode; checked 23 Nov) and makes `DSHProxy.app` in the checkout's root, as `app\build.ps1` makes `DSHProxy.exe` there; ad-hoc signed; ignored by git. It records the checkout's path in the app, so the app still finds `bin/dshproxy.js` when moved to `/Applications`.
- Everything it does to the gateway goes through what the Windows app uses: `GET /dshproxy/status`, the control API with the token from `control.token` (a native program sends no `Origin`, so the API needs no change), and the same CLI commands (`status --json`, `key set` with the key on standard input, `dsh apply|verify|remove`, `dsh bundle`, `video ...`, `dshproxy-krea status|login|logout`).
- `node` is looked for as the plugin runner does: `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin` (an app started from Finder or at login gets a short `PATH`).

## Acceptance criteria

Automatic (CI on both Mac processors; Windows untouched):

- **D1.** `app-macos/build.sh` builds the app with the Command Line Tools alone; the app's `Info.plist` has `LSUIElement`; `swift run KitChecks` passes.
- **D2.** `DSHProxyKit` finds `node` in `PATH` or the Homebrew folders, and the checkout recorded at build time; says in one sentence what is missing.
- **D3.** Starting: the Kit starts `node bin/dshproxy.js start` with the user's data folder, sees the gateway answer `/dshproxy/status`, and tells "own" from "another gateway already running" (as the Windows app does). Stopping: `stop --when-idle`, then the process is gone. With a stand-in for `node`, in `KitChecks`.
- **D4.** Every control call the Windows app makes is made by the Kit with the token in the header and no `Origin`, against a stand-in server that checks it; errors come back as one sentence.
- **D5.** Keys typed in the app reach the CLI on standard input only, never in arguments or the environment.
- **D6.** Nothing changes for Windows; the Node test suite and its CI stay green.

By hand, on the user's Mac:

- **DM1.** Each item of `research/app-inventory.md` sections 1–2 is present or listed in this document as a deliberate difference; checked page by page by the user.
- **DM2.** Closing the window leaves the gateway running; Quit stops it; the menu-bar icon shows the state; while stopped, the menu offers Start.
- **DM3.** Start at login: after logging out and in, the gateway runs with no window open.
- **DM4.** A sign-in, an API key and Apply to DeepSeek Harness from the app (the sign-in is the user's).

## Facts to establish before building (on this Mac)

1. Start at login for an ad-hoc signed app: `SMAppService.mainApp` (macOS 13+) or a LaunchAgent in `~/Library/LaunchAgents`. Which one works without a developer account, and what System Settings shows.
2. Notifications (`UNUserNotificationCenter`) from an ad-hoc signed app: do they appear, and does macOS ask first.
3. Opening the provider's sign-in page in the browser and the Krea consent page: `NSWorkspace.open` with the same checks of the address the Windows app makes.
4. Single instance: a second start shows the window of the first.

## Plan (slices; red before green in `KitChecks` where there is logic)

- **D0** facts 1–4 above, each with a probe; recorded in `research/facts.md`. Probes 1 and 2 change what the user sees (a login item in System Settings; a notification permission dialog), so they run only with the user's word and are undone afterwards.
- **D1** the package, `build.sh`, `KitChecks` in CI; node and checkout lookup (D1, D2).
- **D2** gateway lifecycle in the Kit (D3).
- **D3** control client and CLI calls (D4, D5).
- **D4** the menu bar and the window shell (states, Chat/Video switch, tabs), wired to the Kit.
- **D5** Chat pages one by one, each against the inventory.
- **D6** Video pages.
- **D7** Start at login, notifications, single instance.
- **D8** README (macOS app section), review, DM1 to DM4 with the user.

## Deliberate differences from the Windows app (so far)

- While the gateway is stopped, the window says so and the menu-bar item offers Start (user's decision, 23 Nov).
- Others will follow the prototype review; the web prototype's list (`prototype/README.md`) is the starting point.
