# Windows app inventory (yardstick for the macOS app)

Gathered 2026-11-23, read-only, branch `macos-port` at `c721af1`. Nothing was run; everything below is read from the source.

Abbreviations used in citations:

| Tag | File |
|---|---|
| `A` | `app/DSHProxyApp.cs` (6,601 lines) |
| `S` | `app/Skin.cs` (1,992 lines) |
| `B` | `app/build.ps1` |
| `D` | `src/daemon.js` |
| `K` | `src/control.js` |
| `G` | `src/gateway/server.js` |
| `C` | `src/cli.js` |
| `R` | `README.md` |

"Running" below means the header state Running (the gateway answers); many actions refuse with "Start the gateway first." otherwise.

---

## 1. Window and tray

### 1.1 Program start, arguments, environment

- [ ] Culture forced to `en-US` for dates and numbers; times shown in the local time zone (A:53-61).
- [ ] Arguments:
  - [ ] `--hidden`: starts in the tray, window not shown; the startup work still runs (A:103, A:1127-1137).
  - [ ] `--preview`: read-only second window: own random mutex, no tray icon, starts/stops/changes nothing, video pages use sample data (A:64-69, A:1161-1166, A:3034-3037).
  - [ ] `--preview-limits <file.json>`: shows the Accounts page with the sample limits from the file, starts nothing, title "DeepSeekProxy (preview)", state chip "Preview", detail "Sample limits. Nothing is running." (A:95-101, A:1151-1160). Sample file: `app/preview-limits.json`.
  - [ ] `--tab <n>`: open on section n (A:953-957).
  - [ ] `--workspace video`: open in the Video workspace (A:958-960).
- [ ] Environment read: `DSHPROXY_HOME` (else `%USERPROFILE%\.dshproxy`) (A:432-436); `DSHProxyDebug=1` appends paint/timing lines to `%TEMP%\dshproxy-paint.log` (A:26-42).
- [ ] Finding the program folder: walk up from the exe's folder until `bin\dshproxy.js` exists (A:291-300).
- [ ] Finding Node: every `PATH` entry (split on `;`) + `node.exe`, then `%ProgramFiles%\nodejs\node.exe` (A:302-316).
- [ ] Either missing: error box, exit code 1. Texts: "DSHProxy.exe must stay in the DSHProxy folder (next to bin\dshproxy.js)." / "Node.js was not found. Install Node.js 22 or later.", title "DSHProxy" (A:900-904).
- [ ] On first show (or at once when `--hidden`): start the gateway, start status checks, start the 60 s limits timer (A:1139-1173). Read-only: only status checks (A:1161-1166).

### 1.2 Single instance

- [ ] Named mutex `dshproxy-windows-app` (preview: `dshproxy-windows-app-preview-<guid>`) (A:69).
- [ ] Second launch: opens the named auto-reset event `dshproxy-windows-app-show`, sets it, exits silently (A:48, A:76-83). The first instance created the event before its window (A:90-92) and a background thread waits on it (A:881-897), then `ShowRequested`: show, restore from minimised, activate, `TopMost` on/off, bring to front (A:1552-1558, A:1494-1499).
- [ ] If the event cannot be opened: message "DeepSeekProxy is already running. Open it from the tray icon." title "DeepSeekProxy", Information (A:84-87).

### 1.3 Window size and layout rules

- [ ] Title "DeepSeekProxy" (A:908); icon at system icon size (A:917).
- [ ] Opens on the screen under the mouse pointer (A:912).
- [ ] First size: up to 1280×880, never more than 92% of the screen's working area, centred (A:964-976).
- [ ] Minimum size: 860×600, or 92% of the working area where less (A:972, A:913); re-evaluated after every move/resize to another screen (A:936, A:978-985).
- [ ] All content in one centred column, max width 1240 px; backdrop fills the rest (A:987-1043).
- [ ] "Short window" mode when client height < 760 (A:997, A:1023): header 62 or 84 px instead of 104, icon tile 44 instead of 60, name font Light 17 instead of 22, tighter paddings (A:1045-1080, A:1000-1001).
- [ ] Header status lines go under the buttons when too long to fit beside them (A:1052-1058, A:1075-1079).
- [ ] Workspace switch and section strip: two rows; side by side in a short window that is wide enough, then the workspace hint line is hidden (A:1082-1125).
- [ ] Bottom row height follows the wrapped footer text (A:1028-1041).
- [ ] Resize: while the edge is dragged, a stretched screenshot of the window is shown and layout happens once at the end; watchdog 220 ms (A:930-937, A:1501-1549). Backdrop re-rendered 160 ms after the last resize step (S:187-215).
- [ ] Dark title bar via DWM attributes 20 (dark mode), 35 caption `#04202E`, 34 border `#1C4657`, 36 text (S:1823-1838); dark scroll bars via `SetWindowTheme("DarkMode_Explorer")`, combos `DarkMode_CFD` (S:1840-1845, S:1567).

### 1.4 Header (visible on every page of both workspaces)

- [ ] App icon tile (AppMark, 60 px, rounded, brass glow) (A:1228-1232, S:850-887).
- [ ] Name "DeepSeekProxy" (A:1242) and state chip (A:834, A:1263-1268).
- [ ] Detail line (A:835) and "lowest limit" line (A:836, A:2344-2354): "Lowest limit: {account label} {window title}, {n}% left", coloured by threshold (A:2331, A:2338); empty when no accounts.
- [ ] Buttons: **Apply to DeepSeek Harness** (primary, accessible description A:840), **Start** (primary, 104×40), **Stop** (danger, 104×40) (A:837-840, A:1253-1259).
- [ ] Four gateway states (A:2010-2074):

| State | Chip text / colour | Detail line | Tray tooltip | Start / Stop |
|---|---|---|---|---|
| Running | "● Running" Ok | "{origin}  ·  {backend name} {version}  ·  {n} account(s)  ·  {m} models offered" (A:2126), else the origin | "DSHProxy: running" | off / on |
| Starting | "● Starting" Warn | "The gateway is starting." | "DSHProxy: starting" | off / on |
| Not answering | "● Not answering" Warn | "The gateway process is running but does not answer. Stop asks before it cuts anything." | "DSHProxy: not answering" | off / on |
| Stopped | "● Stopped" Bad | "The gateway is not running. Press Start." | "DSHProxy: stopped" | on / off |

  - [ ] Starting becomes Not answering after 30 s without a first answer (A:1797-1798, A:2025-2028).
  - [ ] Extra chip "Status unavailable" (Bad) with the command's stderr as detail after 3 failed full statuses in a row (A:2078-2088).
  - [ ] On a state change the Accounts page shows (A:2061-2073): "The gateway is not running. Press Start to see accounts and limits." / "The gateway is not answering. Accounts and limits are shown again when it does." / "The gateway is starting. Accounts and limits are shown when it answers."

### 1.5 Backend update bar (below the header)

- [ ] Visible only when Running and (an update is available or a previous version is kept) (A:2903-2905).
- [ ] Text, update available: "CLIProxyAPI {latest} is available (you run {current}), released {d MMM HH:mm}. Updating tries it first and keeps {current} for rollback." (A:2893-2898). Otherwise: "Running CLIProxyAPI {current}. The previous version {previous} is kept." (A:2899-2902). Source: `status --json` `update` and `backendLock` (C:322-323).
- [ ] **Update...** (primary, only when available) → Yes/No, default No, title "Update CLIProxyAPI", text (A:2942-2944): "Update the backend to CLIProxyAPI {v}?\n\n1. Download it and check it against the release's published checksum.\n2. Start it on a spare port and send one short request through each signed-in account (uses a tiny bit of quota).\n3. Only if that passes: restart DSHProxy on {v}, about 5 seconds offline.\n\nIf anything fails, DSHProxy stays on the version you have." → button disabled, label "Downloading and trying CLIProxyAPI {v}... this takes up to a minute." → `POST update/apply` {} with 300 s timeout (A:2946-2957) → message box with `message`, "\n\nTrial run:\n• …" per `checks`, and "\n\nDSHProxy is restarting on the new version." when `ok`.
- [ ] **Roll back...** (only when `backendLock.previous`) → Yes/No, default No, title "Roll back", text "Go back to CLIProxyAPI {previous}?\n\nDSHProxy restarts, about 5 seconds offline." → `POST update/rollback` {} → log line `message` (A:2960-2966).
- [ ] Sentence wraps in front of the buttons; buttons stay at the right edge (A:2909-2936).

### 1.6 Workspace switch and section strip

- [ ] Label "Workspace" (bold) + glass capsule with two radio segments **Chat** / **Video**, 96×34 each, arrow keys move between them, accessible names "Chat workspace"/"Video workspace" with descriptions (A:3009-3010, A:3039-3055, S:716-778).
- [ ] Hint line beside the switch (A:3107-3109): "Chat accounts, keys, lanes and models." / "Video routing setup. Nothing is generated or charged from this window." / on Log: "The log is shared by the Chat and Video workspaces."
- [ ] Section strip (NavStrip): glass capsule of pills, one per section (Accounts, API keys, Lanes, Models, DeepSeek Harness, Log); click or Left/Right keys; hover highlight; focus ring (S:949-1077).
- [ ] Switching workspace keeps the selected section index (A:3080-3110); Video sections 0-4 show the video pages, section 5 (Log) shows the shared log (A:3082-3098).
- [ ] Entering Video reads `video settings` and the page's own state (A:3057-3071, A:3703-3711); returning to Chat on Accounts scrolls to top and reloads limits (A:3072-3077, A:1430-1445).
- [ ] Focus is moved to the section strip on every page change (A:1432-1435).

### 1.7 Footer

- [ ] Text "Data: {home}    Program: {program folder}    Build: {stamp}" with non-breaking spaces (A:1270-1277, A:2128). `{home}` from `status --json` (C:327). Stamp = `yyyy-MM-dd HH:mm <short commit>` written into `BuildInfo.cs` at build time (B:22-35).
- [ ] Check box **Start with Windows** (A:869, A:942-943, A:1453): reads/writes the Run key (section 4.3).

### 1.8 Tray icon and menu

- [ ] Icon: embedded app icon at small-icon size, fallback `SystemIcons.Application` (A:1477). Tooltip "DeepSeekProxy", then the state texts in 1.4 (A:1478, A:2035-2050).
- [ ] Menu (dark renderer S:1847-1880), in order (A:1480-1489):
  1. **Open DeepSeekProxy** → show window
  2. **Add account...** → show window + Add account flow
  3. separator
  4. **Start gateway** → same as Start
  5. **Stop gateway** → same as Stop (asks when requests are in flight)
  6. separator
  7. **Quit**
- [ ] Items are never greyed out by state (no `Enabled` changes in the code).
- [ ] Double-click → show window (A:1490). Balloon click → show window and go to section 0 (A:1491).
- [ ] Hidden in preview and read-only windows (A:1154, A:1163).

### 1.9 Closing, quitting

- [ ] Close box hides the window and keeps the gateway running, except when quitting, in preview/read-only, or on Windows shutdown (A:1560-1565).
- [ ] First hide only: balloon, 4 s, Info: title "DeepSeekProxy is still running", text "The gateway keeps serving DeepSeek Harness. Right-click the tray icon to quit." (A:1566-1570).
- [ ] **Quit** (A:1573-1598): asks first when requests were in flight or the gateway does not answer (ConfirmCut, A:4241-4256; texts in 2.x "Stop"); cancels a waiting Krea sign-in and a waiting idle-stop on a foreground thread so the process waits for them (A:1576-1591); stops timers; stops the gateway (taskkill tree); hides the tray icon; exits.
- [ ] Stop/Quit confirmation (A:4243-4256, A:6416-6423, A:6397-6409): title "Stop gateway" or "Quit DeepSeekProxy", Warning, default **No**. Text: "{N} model request(s) was/were in flight when the gateway was last checked, a few seconds ago at most. Stopping the gateway now cuts it/them.\n\nStop anyway?" (Quitting: "Quitting stops the gateway now and cuts …" / "Quit anyway?"). Not answering variant: "The gateway did not answer when it was last checked, so requests may be in flight.[ N model requests were in flight when it last answered.] Stopping the gateway now cuts any that are.\n\nStop anyway?". A second Stop/Quit while the question is open does nothing (A:4250-4253).

### 1.10 Notifications

- [ ] Exactly one notification exists: the "still running" balloon in 1.9 (A:1569).
- [ ] No notification for low limits (comment A:2533-2534) and none for new models (A:2842-2843). See section 6 for the README conflict.
- [ ] Screen-reader announcements (UI Automation `RaiseAutomationNotification`) of the status line of the video page on screen when it changes (A:3270-3302, A:3713-3724).

### 1.11 Gateway process: start, stop, restart

- [ ] **Start** (A:1632-1679): skipped in read-only, or when its own child is alive. First asks `GET {origin}/dshproxy/status` (1.5 s timeout, any 200) (A:1614-1630); if something answers: log "A gateway is already running on {origin}; showing its status." and start nothing. Otherwise runs, hidden:
  - `"{node.exe}" "{root}\bin\dshproxy.js" start`, working directory `{root}`, no window, stdout/stderr redirected UTF-8 to the log, stdin not redirected (A:324-346, A:386-392, A:1655).
  - Environment: inherited unchanged from the app (no variable set) (A:331-346).
  - Log lines: "Starting the gateway...", on exit "Gateway stopped.", on failure "Could not start the gateway: {error}" (A:1659-1677).
  - After start: header Starting, checks every 250 ms for 10 s (A:1669-1671, A:1835-1840).
- [ ] **Stop** (A:1718-1743): only a gateway this window started. Foreign gateway that answers: log "The running gateway was not started by this window. Stop it from the window it was started in." Own: `taskkill.exe /PID {pid} /T /F` (wait 10 s), then delete `{home}\control.token`. Cuts at once (after ConfirmCut).
- [ ] **Restart for a key change** (A:4043-4158), offered after a successful `key set`/`key remove` when this window's gateway is alive (A:4534-4538): question "{command output}\n\nRestart the gateway now so it uses the change?" (+ "\n\n{N} request(s) is/are in flight: the restart waits for a moment with none, at most 5 minutes, and cuts nothing." when N>0), Yes/No, Information, default Yes.
  - [ ] Nothing in flight and answering: Stop + Start (A:4056-4061).
  - [ ] Otherwise: runs `node bin\dshproxy.js stop --when-idle --wait 300` (A:5862-5888) and shows **RestartWaitDialog** (A:5983-6073): title "Restart gateway"; text "Waiting for {N} request(s) to finish before restarting" (live count from the fast check, A:1984) / "Nothing is in flight now. Waiting for the gateway to stop before restarting."; note "The gateway keeps serving until a moment with nothing in flight, for at most 5 minutes. Cancel leaves it running; the key change is then used after the next restart."; one button **Cancel** (Esc and close box = Cancel; shows "Cancelling the restart..." and kills the command, dialog stays until the wait has ended).
  - [ ] Outcomes (A:5891-5903, A:4102-4157): exit 0 `{"stopped":true}` → wait up to 15 s for the child, start again, log "Restart: the gateway stopped at a moment with nothing in flight. Starting it again."; exit 2 `{"stopped":false,"inFlight":N}` → warning box "{N} requests are still running after 5 minutes of waiting.\n\nNothing was restarted: the gateway keeps running as it was. The key change is used after the next restart of the gateway."; Cancelled → log "Restart cancelled: …"; anything else → Yes/No (default No) "The gateway could not be asked to wait for an idle moment:\n{message}\n\n{N} model requests were in flight … Restarting the gateway now cuts them.\n\nRestart anyway?" (A:6389-6414).
  - [ ] Command timeout 390 s (A:5957-5962).
  - [ ] "Late stop" watch: if the gateway was left running but its process ends within 30 s, it is started again once; log "The gateway had already begun to stop; it was started again." (A:4160-4232).
- [ ] Restarts after backend update/rollback are done by the gateway process itself (C:430-451, D:240); the app only sees them through status.
- [ ] Child exit while Starting/Not answering → header Stopped (A:1681-1695).

### 1.12 Status polling

- [ ] Fast check: raw TCP `GET /dshproxy/status HTTP/1.1` with `Connection: close`, 2 s overall, 400 ms connect on loopback, 1 MiB cap, handles Content-Length/chunked/close (A:5654-5840). Every 3 s when the window is visible and not minimised, 15 s otherwise, 250 ms after a miss (until 3 misses) or for 10 s after Start/Stop (A:1769-1774, A:1828-1833). Not before a full status has given the origin (A:1907-1909).
- [ ] Three misses in a row → not answering/stopped; one slow answer does not flip the display (A:1937-1964).
- [ ] Any change in the status JSON other than `inFlight` → full status (A:1970-1982, A:5822-5839).
- [ ] Full status: `node bin\dshproxy.js status --json`, 20 s timeout (A:1880-1904); at start, on change, after every action, when the window comes back on screen, otherwise every 60 s visible / 600 s hidden (A:1773-1774, A:1842-1853); one at a time; retried after failure, but at most every 15 s after 3 failures (A:1848); "soon" refreshes no sooner than 10 s apart (A:1863-1878).
- [ ] Limits: every 60 s (A:950-951); skipped while hidden if read < 10 min ago (A:2265); also on entering Accounts, after Running begins (A:2131, A:1992).

### 1.13 Log handling

- [ ] Log page: read-only multi-line text box, monospace 9 pt, no wrap, vertical scroll (A:868, A:1417-1424).
- [ ] Appended: gateway stdout/stderr lines (A:1659-1660), app events (sign-ins, account actions, presets, models, updates, video actions, restarts) and full output of CLI commands it runs (A:4437, A:4503, A:4533).
- [ ] Trimmed: above 400,000 characters keep the last 200,000 (A:1610).
- [ ] Not saved by the app; the gateway writes `dshproxy.log` itself (D:95-98, R:187).
- [ ] **Open data folder** → Explorer on `{home}` (A:1421-1423, A:4548-4554).

---

## 2. Pages

### 2.1 Chat › Accounts (A:1306-1315, A:2252-2660)

- [ ] Note: "Subscription accounts and how much of each limit is left. Bars turn amber below 30% and red below 10%." (A:1314)
- [ ] Bottom row: **+ Add account** (primary), **Refresh limits**, **Open credentials folder**, limits note (A:1307-1315).
  - [ ] **+ Add account** → if not Running: "Start the gateway first. Sign-in runs through it." title "Add account" (A:2538-2541); else SignInDialog (2.1.1). After success: log "Signed in: {account}", switch to Chat, section 0, full status, `GET limits?refresh=1` (A:2543-2556).
  - [ ] **Refresh limits** → `GET limits?refresh=1`, 60 s (A:1310, A:2262-2291).
  - [ ] **Open credentials folder** → Explorer on `{home}\auth` (or `{home}`) (A:1312, A:4548-4554).
  - [ ] Limits note: "Reading limits..." / "Could not read limits: {error}" / "Limits updated {just now|N min ago|HH:mm}. They refresh every minute." (A:2267, A:2282, A:2295, A:270-276).
- [ ] Messages instead of cards: "Starting..." (A:1472); "No accounts yet. Press "+ Add account" to sign in to Claude, ChatGPT, Gemini or Kimi." (A:2305); gateway-state messages (1.4).
- [ ] Cards rebuilt only when the `limits` JSON changes (A:2296-2300); third column the same width on every card so bars line up (A:2335-2337).
- [ ] One card per account (A:2356-2531), data from `GET limits` (D:315-321):
  - [ ] Provider logo 24 px; label bold 11 pt; e-mail muted, beside the name or on its own line when narrow (A:2386-2414, A:2487-2528).
  - [ ] Plan chip (teal), underscores → spaces, cut to 15 chars + "…" past 16 (A:2401-2404).
  - [ ] "Primary" chip (green) when `primary` and `siblings` > 1 (A:2405-2409).
  - [ ] "● Paused" (muted) / "● Active" (green) (A:2410).
  - [ ] Buttons (right): **Sign out...** (danger), **Pause** / **Resume**, and **Make primary** (siblings>1, not primary, not paused) or **Not primary** (siblings>1, primary) (A:2416-2434).
  - [ ] One row per limit window: title (muted if not reported); bar (Meter, 8 px, rounded, gradient, A:482-525); "{n}% left · resets in {X min | H h M min | D d H h} ({today|tomorrow|ddd d MMM} HH:mm)" or "reset time not reported", min width 330 px (A:2442-2462, A:253-268). Not reported: "Not reported for this plan" (A:2457).
  - [ ] Colours: left ≤ 10 → red `#F27C6C`, ≤ 30 → amber `#F2C14E`, else green `#5BDCA8` (S:49-59).
  - [ ] Reset strip when `resets.available` > 0 and not paused: red-tinted glass; chip "⚠ 1 limit reset" / "⚠ {n} limit resets"; "Danger zone: spending one cannot be undone."; **Use a reset…** (filled red) (A:2463-2476).
  - [ ] Notes: "Paused: DSHProxy does not use this account until you resume it." / "{label} does not report its limits." / the `error` text in red (A:2477-2486).
- [ ] Actions:

| Button | Confirmation | Call | After |
|---|---|---|---|
| Sign out... | Yes/No, Warning, default No, title "Sign out": "Sign out of {label} ({email})?\n\nDSHProxy stops using this account and deletes its saved sign-in. Lanes move to their other models. You can sign in again at any time." (A:2624-2629) | `POST accounts/remove` `{file}` (A:2630) | log "Signed out of {label} ({email})." |
| Pause / Resume | none | `POST accounts/disable` `{file, disabled}` (A:2633-2636) | log "Paused/Resumed {label} ({email})." |
| Make primary | none | `POST accounts/primary` `{file}` (A:2426) | log "{label} ({email}) is now the primary account: it is used until it runs out, then the other one takes over." |
| Not primary | none | `POST accounts/primary` `{file, primary:false}` (A:2432) | log "{label} has no primary account now: its accounts take turns." |
| Use a reset… | see 2.1.2 | `GET resets?file=` then `POST resets/use` | message box with `message`; limits re-read |

  All account calls: wait cursor, 30 s, on failure error box title "Account" with the gateway's `error`; on success full status + `GET limits?refresh=1` (A:2638-2660).

#### 2.1.1 SignInDialog "Add an account" (A:527-812)

- [ ] Fixed dialog 548×520, centred on the window, no taskbar entry (A:558-565).
- [ ] Choice screen: heading "Add an account"; text "Pick the subscription to sign in to. Your browser opens to the provider's own sign-in page; DSHProxy never sees your password."; one tile per provider (from `status.loginProviders`, else Claude, ChatGPT (Codex), Gemini (Antigravity), Kimi) with logo 30 px and description: "Claude Pro or Max. Opens claude.ai." / "ChatGPT Plus or Pro. Opens chatgpt.com." / "Google AI Pro or Ultra. Opens accounts.google.com." / "Kimi Code. You type a short code on kimi.com."; button **Cancel** (A:542-552, A:607-645).
- [ ] Starting: "Asking the provider for a sign-in link..." → `POST login/start` `{provider}`, 30 s (A:658-682).
- [ ] Waiting screen: logo 44 px, heading "Signing in to {label}", instruction ("Sign in on the {label} page that opened and approve access. When it says you are signed in, come back here." or, for device flow, "Enter this code on the {label} page that opened:" + code in large monospace + **Copy code**), indeterminate bar (Marquee, S:1079-1117), "Waiting for you to finish in your browser. This window updates by itself; the sign-in expires after 5 minutes."; buttons **Cancel** (→ `POST login/cancel` `{id}`, back to choices), **Open page again** (primary), **Copy link** (A:684-724). Opens the `url` in the default browser, only if `https` (A:726-733).
- [ ] Poll `GET login/status?id=` every 1.5 s, 15 s timeout (A:535, A:735-767).
- [ ] Success: "✓  Signed in to {label}" (green), account, "DSHProxy can now use this subscription. Its limits appear on the Accounts tab within a minute."; **Done** (primary, default), **Add another** (A:783-795).
- [ ] Failure: "Sign-in to {label} did not finish" (red), message; **Close**, **Back**, and **Try again** when retryable (A:797-811).
- [ ] Closing the dialog cancels an open session (A:571-575).

#### 2.1.2 Limit reset (A:2559-2622, A:6471-6552)

- [ ] `GET resets?file={file}`, 30 s. Failure: "Could not list your resets: {error}" (title "Limit reset"). None: "No limit reset is available on this account right now."
- [ ] **ResetDialog** "Danger zone: use a limit reset", 560×560 (A:6477-6551): red banner "⚠  DANGER ZONE\nUsing a reset spends it for good. There is no undo, and it cannot be moved to another account.\n{n} reset(s) left on this account."; "{label} · {email}"; "A reset makes your used-up limits full again straight away. ChatGPT keeps it only if you have nothing used up."; one line per reported window "Now: {title} {n}% left · {reset}"; "Resets you have:" with one radio per credit (title, description · "expires d MMM yyyy"), first selected; if none named: "ChatGPT did not name the reset; the next one available would be used."; "Type RESET to confirm:" + text box; **Cancel**, **Use this reset** (filled red, enabled only when the trimmed text equals `RESET`, case-sensitive) (A:6475, A:6541).
- [ ] `POST resets/use` `{file, requestId: new GUID, creditId?}`, 60 s (A:2596-2607). Failure: "The reset was not confirmed: {error}\n\nRefresh the limits to see whether it was used before trying again." Success: box with `message`, Information if `code == "reset"`, else Warning; log `message`; limits re-read (A:2608-2620).

### 2.2 Chat › API keys (A:1317-1337, A:2135-2168, A:2229-2250, A:4265-4283)

- [ ] Note: "Pay-per-use API keys. Keys are stored encrypted for your Windows account. Restart the gateway after a change." (A:1336)
- [ ] List columns Provider / Region / State (A:1318-1321); logos 22 px for deepseek, moonshot, zai, qwen, minimax, mistral, openrouter (A:1322-1329). Rows from `status.providers`; state "Saved" (green) / "Saved, cannot be read: add it again" (red) / "Not set" (muted); region label from `providers[].regions` (A:2150-2161). Rebuilt only on change (A:2142-2147).
- [ ] Provider drop-down (filled once) and Region drop-down (follows provider) (A:844-845, A:2164-2168, A:2238-2250).
- [ ] **Add or replace key** (primary) → KeyDialog (title "API key", "API key for {provider}:", masked field, **Save** / **Cancel**, A:6554-6579) → `node bin\dshproxy.js key set {provider} [{region}]` with the key + newline on standard input, 120 s (A:4265-4274, A:4521-4546). Success → restart question (1.11). Failure → output in an error box.
- [ ] **Remove selected** (danger) → Yes/No default No, title "API key": "Remove the saved {Provider} key?" → `key remove {provider}` → same restart question (A:4276-4283).
- [ ] Not in the app: custom OpenAI-compatible endpoints (`key custom …`, C:567-588).

### 2.3 Chat › Lanes (A:1339-1367, A:2170-2193, A:2662-2711, A:4556-4565)

- [ ] Note: "A lane tries each model in order until one answers. Green: can serve. Amber: sitting out after running out of quota. Red: no account or key." (A:1364)
- [ ] "Routing:" + **Max performance** / **Balanced** / **Cheap production**; the active one drawn as primary; tooltips = each preset's `summary` (A:1349-1359, A:2668-2690).
- [ ] Preset note: "Active: {label}. {summary}" or "Custom ladders, edited in settings.json. Pick a preset to replace them." (A:2691-2693).
- [ ] Preset click → if not Running: "Start the gateway first." title "Routing preset"; else Yes/No default No: "Use the {label} routing preset?\n\nThis replaces the ladders of all five lanes. You can switch back or edit them at any time." → `POST lanes/preset` `{name}` → log "Routing preset: {label}." and, if `harnessChanged`, "DeepSeek Harness routes updated. Restart DeepSeek Harness to see them." (A:2696-2711).
- [ ] List columns Lane (110) / "Ladder (first to last)" (780) (A:1340-1346). Row "lane-{name}"; ladder drawn as glass chips joined by "›", each with a dot: ✓ green available, ⏸ amber `coolingUntil` set, ✗ red not available (name greyed); chips wrap to up to 3 lines and rows grow by 28 px per line (A:2177-2190, S:1684-1803, S:1349-1372).
- [ ] **Edit lanes (settings.json)** → `notepad.exe "{home}\settings.json"`; if missing: "settings.json is created the first time a setting is saved, for example when you add an API key. Until then the default lanes are used." title "Lanes" (A:1347-1348, A:4556-4565).

### 2.4 Chat › Models (A:1370-1400, A:2713-2883)

- [ ] Note: "Ticked models are offered to DeepSeek Harness. New models are found automatically every 3 hours; when the list changes, the DSHProxy routes in DeepSeek Harness are updated (restart DeepSeek Harness to see them)." (A:1394)
- [ ] Suggestions panel above the list, hidden when empty: "Newer model: {to} could replace {from} on lane {lanes}." + **Use {to}** → Yes/No default No, title "Lanes": "Put {to} in place of {from} on lane {lanes}?\n\nThe rest of each ladder stays as it is. You can change it back in settings.json." → `POST lanes/replace` `{from, to, lanes}` → log "{to} now replaces {from} on lane {lanes}." (A:2847-2883).
- [ ] List with tick boxes; columns Model 210 / Service 140 / Context 80 / Output 75 / Reasoning 165 / Status 200; Service is the column dropped when narrow; logos 18 px claude/codex/antigravity/kimi; row tooltip "{name}  ·  Service: {service}" (A:1371-1388, A:2775-2790).
- [ ] Rows from `status.modelList`; shown if offered, or "Show hidden models", or reason "switched off"; new+offered first, then by service, then id (A:2729-2745). Context/output as "1.5M"/"200K" (A:2720-2725); reasoning efforts joined, or "none".
- [ ] Status texts: "NEW · found automatically", "Offered", "Offered (you switched it on)", "Off (you switched it off)", "Hidden: older generation", "Hidden: not a chat model", "Hidden: no details known", else raw reason (A:2761-2771). New+offered: brass bold; not offered: muted (A:2791-2792).
- [ ] Tick/untick → if not Running: tick reverted, "Start the gateway first." title "Models"; else `POST models/choose` `{id, offered}` → log "Offering {id}." / "No longer offering {id}." (+ "; DeepSeek Harness routes updated. Restart DeepSeek Harness to see it.") (A:2802-2825).
- [ ] **Check for new models** (primary) → requires Running → "Checking for new models..." → `POST models/refresh` {} → log "Checked for new models[ (catalog not reachable: …)][; DeepSeek Harness routes updated.]." (A:2827-2845).
- [ ] **Show hidden models** check box (A:1391-1392).
- [ ] Note line: "Model catalog not reachable: {error}" / "Last checked {ago}." / "Not checked yet." (A:2197-2201).
- [ ] Any failed control call: error box title "DSHProxy", list rebuilt from status (A:2968-2993).

### 2.5 Chat › DeepSeek Harness (A:1402-1415, A:2206-2226, A:4489-4546)

- [ ] Note: "Apply to DeepSeek Harness, at the top of the window, writes the DSHProxy routes into every DeepSeek Harness profile and keeps everything else. Preview shows what it would change. Verify checks the profiles back: routes, models, default model and credential. Restart DeepSeek Harness after a change." (A:1414)
- [ ] List Profile 220 / Routes 90 / Models 90 / "Points at this gateway" 400, from `status.deepseekHarness.profiles`; last column = error, "Not applied", "Yes", or "No: apply again"; green when applied and current (A:1403-1406, A:2206-2226).
- [ ] **Preview changes** → `dsh apply --dry-run` (120 s) → box titled "Preview" with the output (A:1407-1408).
- [ ] **Verify** (outline) → `dsh verify` (120 s) → log + box "Verify DeepSeek Harness", Information on exit 0 else Warning (A:1409-1410, A:4491-4508).
- [ ] **Remove from DeepSeek Harness** (danger) → Yes/No default No, title "DeepSeek Harness": "Remove the DSHProxy routes from every DeepSeek Harness profile?" → `dsh remove` → box with output (A:1411-1412, A:4510-4514).

#### 2.5.1 Header button "Apply to DeepSeek Harness" (both workspaces) (A:4285-4487, A:4960-5363, A:6075-6373)

- [ ] Second press while one runs does nothing (A:4397-4400).
- [ ] Step 1: `dsh bundle status --json` (30 s); parsed into one of: Installed, Switched off, Other folder, Folder missing, Not installed, Never opened, Not found, Unreadable (A:5064-5109).
- [ ] Step 2: checklist dialog (SetupDialog, title "Apply to DeepSeek Harness", heading "What is in place, and what Apply will do", buttons **Apply** (primary) / **Cancel**) (A:4423-4430, A:6175-6269). Lines with drawn marks (In place ✓ green, To do → brass, Cannot ✗ red, Note ! amber, A:6096-6173); texts at A:5224-5258, e.g. "DeepSeek Harness is installed and has been opened once.", "The chat routes will be written into every DeepSeek Harness profile." / "Each profile is backed up first.\nNothing else in it is changed.", video-tools plan line, "Restart DeepSeek Harness afterwards. DSHProxy does not do that for you."
- [ ] Step 3: `dsh apply` (120 s); output to the log; failure → error box with the output or "The chat routes were not written: the DSHProxy command ended with code {n}." (A:4434-4443).
- [ ] Step 4 (only when the tools will be installed): if a process named `DeepSeek Harness` exists → **HarnessWaitDialog** (A:6271-6373): heading "Quit DeepSeek Harness to install the video tools"; three notes ("The chat routes are written. The video tools can only be installed while DeepSeek Harness is closed." / "Closing its window may not be enough: DeepSeek Harness can stay in the tray, next to the clock. Quit it there too." / "This window closes by itself when DeepSeek Harness has quit, and the video tools are installed then. DSHProxy does not close DeepSeek Harness for you."); polls every 1 s; one button **Skip the video tools** (also Esc/close).
- [ ] Step 5: `dsh bundle install --json` (180 s) → log "Video tools: installed in DeepSeek Harness." / "not installed." (A:4465-4471).
- [ ] Step 6: result dialog, same style, button **OK**, optional **Copy folder path** (→ "Copied" / "Could not copy"), headings "DeepSeek Harness is set up" / "The video tools were not installed" / "The video tools were left switched off" / "The video tools were not checked"; first line "The chat routes were applied. DSHProxy reported:" + up to 10 lines of output ("And N more lines, on the Log page.") (A:5260-5357, A:6191-6194, A:6244-6258).
- [ ] The Video › DeepSeek Harness page is re-read after Apply (A:4482-4487).

### 2.6 Log (shared by both workspaces)

See 1.13. Only button: **Open data folder** (A:1421-1423).

### 2.7 Video › Accounts (A:3187-3201, A:3899-4041, A:5365-5652)

- [ ] Title "Video accounts"; note: "Video has one signed-in service, a Krea workspace. Sign in to Krea starts DSHProxy's separate Krea helper and opens Krea's consent page in your browser. The helper keeps the sign-in; this app sees only whether one is present and until when. The chat accounts (Claude, ChatGPT, Gemini, Kimi) are not used for video. Sign-in with a live Krea workspace has not been verified in this build." (A:3200)
- [ ] List Service / Billed in / Sign-in / State (200/184/126/270), one row: "Krea workspace · krea", "workspace compute units", "In your browser", state; Krea logo (A:3189-3192).
- [ ] State texts: "Not read yet", "Signing in...", "Signed in · until ddd d MMM yyyy, HH:mm" (green), "Not signed in", "Not known" (amber) (A:3910-3965, A:5410-5413).
- [ ] Read only when the page opens: `node bin\dshproxy-krea.js status` (20 s), one line `{"signedIn":true,"expiresAt":<ms>}` or `{"signedIn":false}` (A:3938-3965, A:5384-5408). Status line "State read from the Krea helper at HH:mm:ss; it is read when this page opens, not kept up to date."
- [ ] **Sign in to Krea...** (primary) → `dshproxy-krea.js login`; first stdout line must be an `https` address on `krea.ai`, `www.krea.ai` or `api.krea.ai` (checked as text and as URI, no user-info, default port) and is opened in the default browser; waits 60 s for the address and 240 s for the end; outcome texts at A:5489-5507 (e.g. "Signed in to Krea.", "Krea sign-in did not complete (KREA_REFUSED): …") (A:3967-4005, A:5415-5450, A:5510-5652).
- [ ] **Cancel** (enabled only during sign-in) → kills the helper's process tree (A:4007-4015, A:5541-5554).
- [ ] **Sign out** → Yes/No default No, title "Krea": "Sign out of Krea?\n\nThe Krea sign-in stored on this computer is removed. Video on the Krea workspace route then needs a new sign-in." → `dshproxy-krea.js logout` (A:4017-4041).
- [ ] Preview window: sample row "Sample: not signed in", nothing started (A:3942-3947).

### 2.8 Video › API keys (A:3203-3219, A:3731-3897, A:4770-4958)

- [ ] Title "Video API keys"; note: "Save the key of a pay-per-use video provider here. It is stored encrypted in the DSHProxy data folder, like the Chat API keys, and is used by DSHProxy's video command; a key in the provider's environment variable is used instead when that is set. A saved key is not checked against the provider. Video generation from DeepSeek Harness works on the Krea route only for now." (A:3215)
- [ ] List Provider / Environment variable / Billed in / State (104/166/98/412), from `video key list` (`{"providers":[{provider,label,variable,routes,saved,readable,inEnvironment}]}`, strictly validated, A:4856-4884). State "Not saved" / "Saved" / "Saved, cannot be read: enter it again" (+ " · also set in the environment") (A:4929-4934). Colours: muted / text / amber.
- [ ] Read when the page opens (A:3709, A:3769-3809).
- [ ] **Add or replace key...** (primary; enabled only with a row selected and no command running; double-click a row does the same) → KeyDialog → local check (non-empty, ≤ 512 chars, printable ASCII 0x21-0x7E, texts A:4814-4823) → `video key set {provider}` with key + newline on stdin (20 s) → must answer `{"provider":P,"saved":true}` → list read again; status "Saved the {label} key. It was not checked against {label}." (A:3811-3856, A:4903-4913).
- [ ] **Remove key** → Yes/No default No, title "Video API key": "Remove the saved {label} video key?\n\nDSHProxy's video command can then use {label} only with a key in {VARIABLE}." → `video key remove {provider}` → `{provider, saved:false, removed:bool}` (A:3858-3897, A:4915-4927).
- [ ] Muted label: "The Krea workspace route uses a sign-in instead of a key: see Accounts." (A:3216)
- [ ] A refusal message that contains the typed key is replaced by "DSHProxy refused, with a message that is not shown here because it repeats what was typed." (A:4941-4948).

### 2.9 Video › Lanes (A:3221-3233, A:3573-3669, A:6426-6469)

- [ ] Title "Video lanes"; note: "Each enabled model has exactly one billing route. A paid job is never retried automatically, moved to another provider or passed on to another route. A saved route is a setting: it does not prove a sign-in, a key, availability or a price." (A:3232)
- [ ] List Model / Company / Billing route / Billed in (180/100/250/180): enabled models only; company logo alibaba / minimax / bytedance (A:4730-4744); route cell "Not configured" / "Not allowed: {route}" / "{label} · {route}" (A:3437-3444); billed in from route (A:4746-4758) or "Choose a billing route" (amber). Placeholders "Not available", "Reading...", "Not read yet", "No video models", "None enabled — Tick a model on the Models tab" (A:3341-3404).
- [ ] **Change billing route...** (primary; double-click a row too) → needs a selected row (messages A:3583) → **RouteDialog** "Video billing route", 500×248: "Charge {model} to:", drop-down "{label} · {route} · billed in {units}", note "One route for each model. A paid job is never retried automatically or moved to another route.\r\n\r\nSaving a route does not check a sign-in, a key or a price, and charges nothing.[ The model stays switched off.]", **Save route** (enabled once a route is chosen; nothing preselected for a model without a route) / **Cancel** (A:6426-6469).
- [ ] Save → `video settings set {MODEL} {ROUTE} enabled|disabled` (20 s) (A:3605-3669, A:4624-4629). Status line (shared with Models): "Saving: …" → "Saved: {what}. This is a setting only; nothing was checked or charged." or "DSHProxy answered, but {id} does not read as asked. …"; failure box "The video setting was not saved.\n\n{reason}\n\nThe lists are being read again, so they show what is saved." (A:3630-3668).
- [ ] **Reload video settings** → `video settings` (A:3227-3228, A:3492-3532). Disabled while a video command runs (A:3483-3490).
- [ ] Muted label "Logos show the company behind each model, not a model mark." (A:3335-3339).

### 2.10 Video › Models (A:3235-3244, A:3534-3571)

- [ ] Title "Video models"; note: "Ticked models with a billing route are what the separate DeepSeek Harness video bundle may offer; new models start switched off. A tick is a setting only: it checks no sign-in, key, availability or price, it is not a spending limit, and nothing is generated or charged here. Choose the billing route under Lanes." (A:3243)
- [ ] List with tick boxes (only when there are models) Model / Company / Billing route / Billed in / State (172/90/196/176/146); state "Off" / "Enabled" / "No valid route" (amber) (A:3355-3373).
- [ ] Tick with a valid route → save enabled; untick without a valid route → `video settings set {MODEL} none disabled`; tick without a route → RouteDialog first, tick waits for the choice; ticks ignored while a command runs (A:3534-3571, A:4619-4635).
- [ ] **Reload video settings**; company note (A:3239-3244).
- [ ] Status line texts: "Video settings have not been read yet." / "Reading video settings..." / "Video settings read from DSHProxy at HH:mm:ss." / "Could not read the video settings: …" (A:3266, A:3506-3527).

### 2.11 Video › DeepSeek Harness (A:3246-3264, A:3406-3432, A:4345-4395, A:5156-5220)

- [ ] Title "Video in DeepSeek Harness"; note: "Video reaches DeepSeek Harness through the video tools, a plugin in integrations\dsh-video of the DSHProxy folder. Apply to DeepSeek Harness, at the top of the window, installs it in the DeepSeek Harness desktop app, together with the Chat routes." (A:3262); bottom note "The video tools offer the enabled models above. Their README says what they can do and how far that has been checked." (A:3263)
- [ ] List What / State, four rows: "Video tools installed in DeepSeek Harness?" (from `dsh bundle status --json`, texts A:5158-5171, colour A:5173-5182), "Enabled, with a billing route" / "Enabled, no valid route (not offered)" (from video settings), "Video tools in this DSHProxy folder" → "Found: / Not found: integrations\dsh-video" by checking `{root}\integrations\dsh-video\package.json` (A:3253-3260, A:3406-3432).
- [ ] Status line "Checked at HH:mm:ss. {page line}" (A:4382-4395, A:5186-5199).
- [ ] No buttons on the page; read when the page opens (A:3710) and after Apply.

---

## 3. Control API routes (`src/daemon.js`) and their use by the app

Transport (K:63-91): prefix `/dshproxy/control/`; header `x-dshproxy-token` must equal `{home}\control.token` (written 0600 at start, K:19-23, D:304-305; deleted on stop, D:566); any `Origin` header → 403; unknown route → 404; body JSON ≤ 64 KiB; errors `{error}` with 4xx. The app reads the token fresh on every call ("The gateway is not running. Press Start first." when the file is missing) and maps no-answer to "The gateway did not answer. Is it running?" (A:420-480).

| Method | Name | Body / query | Returns | App use |
|---|---|---|---|---|
| GET | `/dshproxy/status` (not a control route; no token; G:408-411) | — | `{version, startedAt, origin, inFlight, backend, routing, update, discovery, lanes, accounts, apiKeys, deepseekHarness}` (D:250-266) | Yes: fast check raw socket A:5720; "already running" probe A:1625 |
| POST | `login/start` | `{provider}` | `{id, url, flow:"browser"\|"device", userCode}` (D:309; `src/login.js:131-132`) | A:672 |
| GET | `login/status` | `?id=` | `{status:"wait"\|"ok"\|"error", account, error}`; on ok clears caches (D:310-313) | A:744 |
| POST | `login/cancel` | `{id}` | `{cancelled}` (D:314) | A:777 |
| GET | `limits` | `?refresh=1` forces | `{fetchedAt, accounts:[{file, provider, label, account, plan, disabled, state, stateMessage, windows[{title, kind, usedPercent, leftPercent, resetsAt, reported}], resets, supported, error, primary, siblings}]}` (D:315-321, `src/limits.js:331-360`) | A:2272 |
| GET | `limits/raw` | `?file=` | raw usage report for one account (D:322) | **not used** |
| GET | `resets` | `?file=` | `{available, credits[{id,title,description,expiresAt}]}` (D:323, `src/limits.js:448-452`) | A:2569 |
| POST | `resets/use` | `{file, creditId?, requestId}` | `{code, message}`; logs; clears caches on `code:"reset"` (D:324-329) | A:2605 |
| POST | `accounts/remove` | `{file}` | `{removed}` (D:330-336) | A:2630 |
| POST | `accounts/disable` | `{file, disabled}` | `{file, disabled}` (D:337-343) | A:2635 |
| POST | `accounts/primary` | `{file, primary?}` (`false` = clear) | `{provider, primary}` (D:346-357) | A:2426, A:2432 |
| POST | `models/refresh` | `{}` | `{ok, catalogError, harnessChanged}` (D:358-361) | A:2835 |
| POST | `models/choose` | `{id, offered}` | `{ok, harnessChanged}` (D:363-382) | A:2819 |
| POST | `lanes/replace` | `{from, to, lanes[]}` | `{ok, lanes}` (D:384-400) | A:2877 |
| POST | `lanes/preset` | `{name}` | `{ok, preset, harnessChanged}` (D:402-413) | A:2705 |
| POST | `update/check` | `{}` | `{available, latest, current, …, checkedAt, error}` (D:225-234, D:414) | **not used** (the gateway checks by itself every 6 h, D:552-554) |
| POST | `update/apply` | `{}` | `{ok, message, checks[]}` (D:415-419, `src/backend/updater.js:117-137`) | A:2948 (300 s timeout) |
| POST | `update/rollback` | `{}` | `{ok, message}` (D:420, `src/backend/updater.js:153`) | A:2965 |
| POST | `stop` | `{waitSeconds}` 0-86400, default 300 | `{stopped:true}` or `{stopped:false, inFlight}` (D:426-469) | Indirectly: the app runs `dshproxy stop --when-idle --wait 300` (A:5885-5888), which calls it (C:460-510) |

Counts: 18 control routes; 15 called directly by the app, 1 through the CLI (`stop`), 2 unused (`limits/raw`, `update/check`); plus the token-free `GET /dshproxy/status`.

---

## 4. What the app does without the control API

### 4.1 Command lines it runs (all `"{node.exe}" "{root}\bin\…" args`, working directory `{root}`, hidden, UTF-8 pipes, environment inherited) (A:324-346)

| Command | When | Timeout | Stdin | Cite |
|---|---|---|---|---|
| `dshproxy.js start` | Start, auto-start, restarts | long-running | not redirected | A:1655 |
| `dshproxy.js status --json` | full status | 20 s | closed | A:1891; shape C:309-350 |
| `dshproxy.js key set {provider} [{region}]` | Chat API keys | 120 s | key + `\n` | A:4272-4273 |
| `dshproxy.js key remove {provider}` | Chat API keys | 120 s | closed | A:4282 |
| `dshproxy.js dsh apply --dry-run` | Preview changes | 120 s | closed | A:1408 |
| `dshproxy.js dsh apply` | Apply | 120 s | closed | A:4428 |
| `dshproxy.js dsh verify` | Verify | 120 s | closed | A:4497 |
| `dshproxy.js dsh remove` | Remove from DeepSeek Harness | 120 s | closed | A:4513 |
| `dshproxy.js dsh bundle status --json` | Apply, Video › DeepSeek Harness | 30 s | closed | A:5003-5006, A:4373, A:4411 |
| `dshproxy.js dsh bundle install --json` | Apply | 180 s | closed | A:5008-5011, A:4465 |
| `dshproxy.js video settings` | video pages | 20 s | closed | A:4614-4617, A:3461 |
| `dshproxy.js video settings set M R enabled\|disabled` | video save | 20 s | closed | A:4624-4629 |
| `dshproxy.js video key list` / `set P` / `remove P` | Video API keys | 20 s | key + `\n` for set | A:4790-4807, A:3835 |
| `dshproxy.js stop --when-idle --wait 300` | restart for a key change | 390 s | closed | A:5885-5888, A:5958 |
| `dshproxy-krea.js status` / `logout` | Video Accounts | 20 s | closed | A:5378-5380, A:3923 |
| `dshproxy-krea.js login` | Krea sign-in | 60 s + 240 s | closed | A:5379, A:5524-5525 |

Video and setup commands never run two at a time (A:3446-3450, A:4361-4365).

### 4.2 Other processes

- [ ] `taskkill.exe /PID {pid} /T /F` to stop the gateway tree (A:1731) and to end the Krea helper / idle-stop command trees (A:5843-5860).
- [ ] `explorer.exe "{folder}"` for the data and credentials folders (A:4553).
- [ ] `notepad.exe "{home}\settings.json"` (A:4564).
- [ ] Default browser via shell-execute: sign-in URL (https only) (A:726-733) and Krea consent URL (A:5440-5450).
- [ ] Process list by name `DeepSeek Harness` (A:5016-5030); `Process.GetProcessById` for the late-stop watch (A:4179).

### 4.3 Registry

- [ ] `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `DSHProxy` = `"{exe path}" --hidden`; the check box reads it at start and writes/deletes it on change (A:6581-6599, A:942-943).

### 4.4 Files

- [ ] Reads `{home}\control.token` before each control call (A:438-443); deletes it after Stop (A:1742).
- [ ] Checks `{home}\settings.json` exists (A:4558-4559); checks `{root}\integrations\dsh-video\package.json` (A:3427); checks `{root}\bin\dshproxy.js` while locating the folder (A:296).
- [ ] Reads the `--preview-limits` JSON file (A:100).
- [ ] Appends `%TEMP%\dshproxy-paint.log` when `DSHProxyDebug=1` (A:37).
- [ ] Nothing else is written by the app; settings, keys, sign-ins are all through the CLI or the gateway.

### 4.5 PowerShell

- [ ] None in the app. Only the build uses it (`B`). (The CLI it runs uses PowerShell internally on Windows; see facts.md section 3.)

### 4.6 Other OS facilities

- [ ] Named mutex + named event (A:69, A:78, A:92).
- [ ] HTTP to `{origin}/dshproxy/status` and the control API; raw sockets for the fast check (A:5671-5742).
- [ ] Clipboard: Copy link, Copy code, Copy folder path (A:696, A:710, A:6252).
- [ ] Screen capture of the own window for the resize preview (A:1516).
- [ ] UI Automation notifications (A:3297-3302).
- [ ] Win32 calls: `DwmSetWindowAttribute`, `SetWindowTheme`, `DrawIconEx`, `SendMessage(LVM_SETEXTENDEDLISTVIEWSTYLE)`, `GetWindowLong` (S:109-125, S:1132-1136, S:1812-1845).
- [ ] Gateway origin starts as `http://127.0.0.1:8417` and is replaced by `status.origin` (A:828, A:2094-2117).

---

## 5. Assets

- [ ] App icon `app/icon/DSHProxy.ico`: 7 frames, 16-256 px, PNG frames; embedded as the exe icon and as resource `app.ico`; loaded at the size wanted (tray small icon, title bar, 64 px header tile) (B:12-14, B:39-41, A:108-122, A:1230-1231, S:112-125). Artwork: brass compass needle over a dark sea, original (`app/icon/NOTICE.md`).
- [ ] `app/icon/favicon-32.png`: not used by the app; used by the gateway's sign-in confirmation page (`src/login.js:17`).
- [ ] Logos `app/logos/*.png`, 64×64, embedded as `logo.{name}.png` (B:16-20), from LobeHub Icons 2.7.0, MIT, trademarks of their owners (`app/logos/SOURCE.md`). Use:
  - claude, codex, antigravity, kimi: sign-in tiles (30 px), account cards (24 px), Models list (18 px) (A:635, A:2387, A:1382).
  - deepseek, moonshot, zai, qwen, minimax, mistral, openrouter: Chat API keys (22 px) (A:1324).
  - krea: Video Accounts (22 px in a 30 px slot) (A:3190).
  - alibaba, minimax, bytedance: Video Lanes/Models (company of wan-3.0, minimax-h3, seedance-*) (A:4731-4744).
  - VideoRouter, KovAPI, Callirra: text only, no logo (A:3205).
- [ ] Fonts: system only, none bundled: UI "Segoe UI Variable Text" (< 12 pt) / "Segoe UI Variable Display" (≥ 12 pt), fallback "Segoe UI"; headings "Segoe UI Variable Display Light" / "Segoe UI Light"; mono "Cascadia Mono" / "Consolas" (S:71-98). Sizes used: 8.5 (column headers), 9, 9.5 (base), 10, 10.5, 11, 12, 13, 14, 15, 17, 22.
- [ ] Palette (S:21-59): page `#02101A`, card `#0A2230`, input `#061824`, log `#04121C`, text `#F5FCFB`, muted `#B4CCD4`, accent/brass `#E4B26A` (hover `#F3CB8B`, deep `#B8873F`, ink `#1E1403`, dim `#15303E`), teal `#57D9C9`, ok `#5BDCA8`, warn `#F2C14E`, bad `#F27C6C`, bad dim `#3A1A18`.
- [ ] Look (S:1-9, S:134-485): backdrop gradient `#061A24`→`#020B11` with 150 seeded stars (seed 1846) in the top 62%; translucent "glass" panels with a top sheen and lit edge; pill buttons in five kinds (Normal, Primary brass, Danger red text, DangerStrong filled red, Outline brass edge) (S:491-640, S:1390-1403); custom check box, radio, segment switch, chip, marquee, owner-drawn lists with hover/selection bands and proportional columns (S:642-1385, S:1590-1803); themed message boxes with drawn glyphs ×, !, ?, i; the lit (default) button in Yes/No is the safe one (S:1883-1991).
- [ ] Sample data built in: video settings (A:4760-4767), video keys (A:4950-4957), bundle state (A:5359-5362); `app/preview-limits.json`.

---

## 6. Ambiguous or not determined

1. **Low-limit notification.** `R:40` says "a tray notification warns once when a limit drops to 10%"; the code says there is none (A:2533-2534) and the `warned` set is declared but never used (A:832). Which one is the yardstick?
2. **Thresholds.** The note says "below 30%" / "below 10%" (A:1314, R:40); the code colours at ≤ 30 and ≤ 10 (S:56-57).
3. **Reset phrase.** The comment says the dialog waits for "CONFIRM" (A:6472); the code requires `RESET` (A:6475), as the README says (R:233).
4. **README vs. app.** The README's app section does not mention the Chat Models page or the Video DeepSeek Harness page, and says the Video workspace has "the same sections" (R:36-46).
5. **Windows shutdown and crashes.** On `WindowsShutDown` the window closes without `StopGateway` (A:1562); whether the gateway child outlives the app then, or after an app crash, is not handled in the app (no job object). Not determined.
6. **Start with Windows in preview windows.** The check box works, and writes the Run key, in `--preview` and `--preview-limits` windows too (A:942-943); probably unintended.
7. **Tray menu state.** Items are never disabled; "Start gateway" while running and "Stop gateway" on a foreign gateway only write a log line (A:1643-1652, A:1723-1727).
8. **Preset highlight.** A non-active preset button has its `Tag` set to null (A:2680), which also clears any other skin kind; harmless today, noted for exact look.
9. **Video status line** is one text shown on both the Lanes and Models pages (A:3270-3280).
10. **Origin before the first full status.** The fast check waits for `origin` from `status --json` (A:1907-1909); the start probe uses the default `http://127.0.0.1:8417` until then (A:828, A:1648).
11. **Icon licensing.** `B:12` says "Personal use only: see app\icon\NOTICE.md", while the notice says the shipped icon is original artwork publishable with the source; the notice cites `app/icon/generate.md`, which is not in the folder.
12. **High DPI.** No DPI awareness manifest or `AutoScaleMode` setting found in the code; pixel sizes above are logical WinForms values. How it scales on Windows was not checked.
13. **macOS-specific outcomes not testable here**: `dsh bundle` and the Krea helper say "not available on macOS yet" (C:381-385, R:30), so Video › Accounts and Video › DeepSeek Harness (and step 1/5 of Apply) would show failures on a Mac until stages B/C.
14. **Node discovery.** The app finds `node.exe` on `PATH` split by `;` (A:302-316). A macOS app started from Finder or at login gets a minimal `PATH`; the equivalent search rule is not defined anywhere yet.
15. **Exact pixels and rendering** come from code only; the app was not run and no screenshots were taken.
