# App: status polling, memory, restart that waits (measurement notes)

22 Nov 2026, 05:40 to 07:15. Worktree `video-routing`. "Before" is the app source of commit `29693af`, built in a separate folder. "After" is the uncommitted `app/DSHProxyApp.cs` and `app/Skin.cs` of this batch.

## How it was measured

- The app's real main window (`new MainForm(true, null)`, what `DSHProxy.exe --hidden` builds) ran inside a small test program, placed in a Windows job object. The job counts every process the window starts, with their children, and their CPU time.
- Data folder: a throwaway `DSHPROXY_HOME` under `%TEMP%` whose `settings.json` names two spare ports, with one synthetic Chat API key saved by the real command line.
- Gateway: a 100-line Node server on the spare port. It answers `GET /dshproxy/status` in the daemon's shape and `GET /dshproxy/control/limits` with the sample accounts. Its limit numbers change on every call, so the account cards are rebuilt once a minute. On a real install they are rebuilt only when a limit number changes.
- The window was at x = -12000, shown with `SW_SHOWNOACTIVATE`, and painted with `PrintWindow` every 5 seconds. It was never the foreground window (checked).
- Nothing touched the running install, ports 8417 and 8418, `%USERPROFILE%\.dshproxy` or `%LOCALAPPDATA%\DSHProxy`.

## Status polling: before and after

| | Before | After |
|---|---|---|
| Processes started, 5 min visible | 400 | 20 |
| Processes started, 5 min hidden | 400 | 0 |
| CPU, 5 min visible (app and children) | 59.0 s (19.7% of a core) | 7.4 s (2.5%) |
| of which the children | 53.9 s | 3.0 s |
| CPU, 5 min hidden | 46.1 s (15.4%) | 0.08 s (0.03%) |
| Full `status --json` runs, 10 min visible | 200 | 9 |
| Requests to the gateway's `/dshproxy/status`, 5 min visible | 100 (all from the command line) | 105 (100 from the app, 5 from the command line) |
| Requests to the gateway's `/dshproxy/status`, 5 min hidden | 100 | 20 |
| Private bytes at minute 0 / 5 / 10, visible | 35.3 / 60.2 / 71.0 MB | 35.8 / 48.1 / 52.4 MB |

Files: `poll-10min-visible-5min-hidden-before.txt`, `poll-10min-visible-5min-hidden-after.txt`. Columns: second, phase, processes ever in the job, job CPU ms, app CPU ms, children CPU ms, private MB, working set MB, handles, status requests seen by the stand-in gateway, limits requests.

- The after figure for the app itself (4.3 s in 5 visible minutes) includes the forced repaint every 5 seconds and a card rebuild every minute. Both runs had them.
- The after private bytes at minute 10 include managed garbage not yet collected. After a forced collection in the test program it is 47.7 MB.
- A full status still costs 4 processes and about 0.5 s of CPU. It now runs once a minute while visible and once in 10 minutes while hidden, plus on the events listed in the ledger.

## What the window still notices, and how fast

File: `follow-and-restart-check.txt`, part A (26 checks, all pass). Times are from the change at the gateway to the window showing it.

| Change at the gateway | Seen after |
|---|---|
| In-flight count changes | 0.4 to 3.0 s, no process started |
| Accounts list changes | 3.0 s, one full status |
| `update` field changes | 2.5 s, one full status |
| Gateway stops | 4.6 s ("Stopped", Start enabled) |
| Gateway starts again | 3.3 s |
| Window shown or restored | full status within 0.1 s |

Also checked there: one answer slower than 2 seconds does not flip the display; a fast check is answered while a full status (made 5 seconds slow) is running; five requests for a full status in a row run it twice, never two at once; 10 full statuses in the whole part, 0 overlaps; hidden and minimised windows ask every 15 seconds.

`status-reader-check.txt` (29 checks) covers the HTTP reader: content-length, chunked, close-delimited, non-200, not HTTP, oversized, `localhost` on IPv4-only and IPv6-only listeners, nothing listening (known in 0.4 s), an answer after 2.6 s (given up at 2.0 s).

## Memory

30 minutes visible, private bytes after a forced collection every 5 minutes (`memory-30min-visible-*.txt`):

| Minute | Before | After |
|---|---|---|
| 5 | 59.1 MB | 47.0 MB |
| 10 | 71.1 MB | 47.4 MB |
| 15 | 82.3 MB | 47.4 MB |
| 20 | 94.6 MB | 47.5 MB |
| 25 | 106.0 MB | 47.5 MB |
| 30 | 118.0 MB | 47.5 MB |
| USER objects at minute 30 | 1,899 | 128 |
| Glass surfaces at minute 30 | 135 | 15 |
| Managed heap at minute 30 | 5.5 MB | 2.3 MB |

- Cause: every rebuild of the account cards left the old cards alive. `accountsPanel.Controls.Clear()` removes controls without disposing them, and the static list of glass surfaces kept each card with its cached bitmaps. One rebuild cost about 2.4 MB of private bytes, 59 USER objects and 4 glass surfaces. Almost all of it is native: the managed heap grew by 0.1 MB per rebuild.
- The same pattern was in the sign-in dialog, the "not running" message, and the model suggestions. With a 20 KB status that changes each time, the before build grew 1.1 MB per 100 status readings; the after build is flat (`scenarios-before-2.txt`, `scenarios-after.txt`).
- Not a source of growth, before or after (`scenarios-*.txt`, each figure after a forced collection): 300 repaints, 300 section and workspace switches (one-time 31 MB for building the pages, then flat), 300 unchanged status readings, 6,000 log lines (the log box is capped at 400,000 characters), 60 message boxes.
- Painted resizes: 1,200 in a row level off. Private bytes move between 37 and 41 MB from round 200 on, with no trend (before build: 40.7 MB at round 300, 39.7 MB at round 1,200; after build: 39.0 MB at round 600, 37.9 MB at round 1,200).
- No `GC.Collect` and no working-set trimming was added to the product. The forced collections above are in the test program only.

## Restart after a Chat key change

File: `follow-and-restart-check.txt`, part B (46 checks, all pass). The window started the real daemon of this worktree through a stand-in command line, with the daemon's backend replaced by a local server, as `test/daemon.test.js` does. Requests were held open at that server to have something in flight.

- One request in flight: the question says the restart waits; Yes opens the waiting dialog (`restart-wait-2.png`); `stop --when-idle --wait 300` is run; the gateway keeps serving (a second request was accepted and the dialog went to "2 requests"); when the requests finished, the old gateway process ended by itself with exit code 0, both requests completed with HTTP 200, and the window started a new gateway.
- Nothing in flight: the question and the restart are as before, no stop command is run.
- Cancel: the command is ended, the gateway logs "the caller went away; the gateway keeps running", same process, request not cut.
- Wait runs out (the stand-in command line shortened the wait to 2 seconds; exit code 2): the message says requests are still running, nothing was restarted, the key change is used after the next restart.
- Command line that does not know `stop` (exit code 1): the yes or no question, No by default; No keeps the gateway, Yes restarts the old way.
- Stop and Quit ask as before. The in-flight count is 0 right after Start, Stop and each restart.
- Quit with a sign-in helper waiting: Quit returned after 0.25 to 0.36 s (three runs); the helper and the gateway were gone when the program ended.

## Not measured here

- The running install, a real backend, real provider traffic, a real Krea sign-in.
- The keyboard part of the six-tab check (arrow keys on the Chat and Video switch) needs the test window to have the keyboard focus, which was not taken this time.
- The 300-second wait itself: the exit code 2 path was driven with a 2-second wait.

## Review fixes (four findings, 22 Nov)

Source: `app/DSHProxyApp.cs`, sha256 `71EDDCC2A7FE2A55` (before: `6090543000271949`), +186 −32. The check programs of the earlier rounds were gone, so they were written again; they are in `harness/`. Their lines and counts differ from the earlier SeamCheck (26), CredCheck (87) and six-tab script.

### 1. A gateway that stops after the window was told it had not

Files: `review-fixes-scenarios-before.txt` (source before the change: 20 FAIL), `review-fixes-scenarios-after.txt` (94 ok, 0 FAIL).

Rule now in the product: after this window has asked its gateway to stop when idle, every outcome except "stopped" leaves a watch on that process for 30 seconds. If the process ends in that time, the gateway is started again once and the log says "The gateway had already begun to stop; it was started again." Stop, Quit and any start from the window end the watch.

The timed scenarios use a stand-in gateway (`harness/bin/fakegw.js`) whose end can be set to the millisecond, and a stand-in for `stop --when-idle` that hangs, says "the connection was lost" (exit 1) or says one request is in flight (exit 2). The real command was not used for these, because the moment cannot be hit on purpose with it.

| Scenario | Before | After |
|---|---|---|
| Cancel, gateway ends 2 s after it was asked | started again, but only because Cancel took 3.6 s (the old 1.5 s probe on a loaded machine) and the gateway had ended by then | Cancel returns in 0.5 s, gateway started again once, 3.6 s after Cancel |
| Cancel, gateway ends 5 s after | no gateway, nothing started | started again once, 6.6 s after Cancel |
| Cancel, gateway never ends | unchanged | same process after 32 s, nothing started, watch ended; a later end starts nothing |
| Exit 1 "connection lost", gateway gone after 3 s | no gateway while the question was open; only Yes started one, No would have left none | started again while the question is still open; Yes then does nothing more |
| Exit 2, then Stop by hand | nothing started | nothing started, watch off |
| Exit 2, then Stop and Start by hand | not applicable | the gateway is the one the user started, started once |
| Cancel, gateway ends late, another gateway has the address by then | not comparable: the gateway had ended before Cancel returned and was started again at once | nothing started, log says a gateway is already running |
| Exit 2, then the gateway ends by itself | no gateway | started again once |

The 46 checks of the earlier round (real daemon, stand-in backend) are in the same file and pass. Two more were added there: after a normal restart and after the fallback restart, the gateway is started exactly once.

### 2. Cancel while the command's process is disposed

File: `review-fixes-cancel-stress.txt`.

`IdleStop.Cancel` and `KreaLogin.Cancel` (the Krea helper had the same pattern) now end the process while holding the lock under which `Run` lets go of it before disposing it. Every other place that ends the process takes the same lock. `ProcessTree.Kill` names `ObjectDisposedException`.

No failure could be produced on the source before the change: 300 rounds for each class, two threads calling Cancel without pause across the dispose, no exception escaped, before or after. `ObjectDisposedException` derives from `InvalidOperationException`, which `Kill` already caught; a `Kill` on a disposed process threw nothing before the change either. The change is therefore by construction, not red-then-green.

### 3. Default button of the sign-in dialog

`Reset` clears `AcceptButton` and `CancelButton` before the contents are released; `ShowSuccess` sets `AcceptButton` again as before. The check (Done, "Add another", signed in again) passes on the source before the change as well: the form already dropped the button when it was removed from the dialog. The change makes it explicit and changes no behaviour that could be observed.

### 4. A gateway of this window that does not answer

Missed checks no longer set the count to 0 while the gateway process this window started is alive. The count goes to 0 when that process ends, and on Start and Stop as before. When the last check failed, the process is alive and the gateway has answered at least once since it was started, Stop and Quit ask: "The gateway did not answer when it was last checked, so requests may be in flight. [2 model requests were in flight when it last answered.] Stopping the gateway now cuts any that are." The restart after a key change asks the same way instead of restarting at once.

Before: Stop asked nothing in that state and stopped the gateway; Quit left without asking (the check program lost its window there). After: both ask, No keeps the same process, and a gateway this window did not start is unaffected (`review-fixes-reruns.txt`, follow).

A gateway that has not answered once since it was started is not asked about: it is still starting.

### Reruns

- `app\build.ps1`: exit 0. `node scripts/check.js`: 69 files OK.
- `review-fixes-reruns.txt`: seam 25 ok, cred 43 ok, six sections 8 ok (0 differing pixels of 1,126,400 on each of the six after Chat, Video, Chat), follow 11 ok.
- `review-fixes-process-count.txt`: two runs of 5 minutes visible and 5 minutes hidden. Hidden: 0 processes started in both. Visible: 16 in both, not 20. That is four full statuses of four processes; they were 59.9 to 63.0 s apart, so the fifth fell just after the 5 minutes. The earlier run measured 20 in its first 5 minutes and 16 in others (for example second 120 to 420 of `poll-10min-visible-5min-hidden-after.txt`: 17 to 33). The pacing code was not touched. Both files end in one FAIL line that is a mistake of the check program, not of the app: the first expected 20 or 24, the second counted the 1.2 s between the two full statuses before the 5 minutes as a gap. The corrected check in `harness/FixCheck.cs` was compiled but not run again.

### Runs that failed on the way

- First run of the scenarios after the change: 1 FAIL, "started once" after the normal restart. The check counted starts from the command line's log before the new process had written its first line. The count is now taken from before the restart.
- Second run: the same, and "it answers again: Running" not within 12 s. The machine was at 94% CPU from other work; one `status --json` took 10.2 s (`06:40:47.887` to `06:40:58.088` in that run's log). The bound is now 45 s and the time is printed: 0.7 s in the run kept here.
- First run of cred: 3 FAIL, all in the check program (it pressed Sign in while the state was still being read, and it expected no gateway although the app starts one when it opens). That run left the stand-in gateway of its throwaway folder running; it was ended by hand. The check now leaves through the app's own Quit.

### Not verified

- Finding 1 against the real `stop --when-idle` command: only the stand-in could be timed. The real command is exercised in the first part of the scenarios, where it answers.
- Finding 2: no failing run exists, see above.
- The running install, a real backend, provider traffic, a real Krea sign-in, the 300-second wait, the keyboard part of the six-section check: as before.
- No independent review: this is a self-review.

## Last batch: gateway states, layout at every size, model ticks (22 Nov)

Source: `app/DSHProxyApp.cs` sha256 `A2DAEC76C0D9BD01` (before: `71EDDCC2A7FE2A55`), `app/Skin.cs` `A69ECACD31419924` (before: `DB0CA718E57BA958`). Diff of this batch alone: `.tmp/desktop-ui-0007-final.diff`. Check programs: `harness/` (`build.ps1` builds one, `run.ps1` runs one, `layout.ps1` builds and runs the layout check).

### A. What the header says about the gateway

Files: `final-scenarios-before.txt` (source before this batch: 96 ok, 8 FAIL, all eight in the new checks), `final-scenarios-after.txt` (104 ok, 0 FAIL), `final-follow.txt` (15 ok).

| State | When | Start | Stop |
|---|---|---|---|
| Running | the gateway answers | off | on |
| Starting | a gateway this window started is a live process and has not answered once since it was started | off | on, asks nothing |
| Not answering | a gateway this window started is a live process, has answered before, and misses its checks | off | on, asks with the sentence about requests in flight |
| Stopped | no gateway process of this window is alive and nothing answers at the address | on | off |

"Starting" was not asked for. It is the same rule applied to the first seconds after Start, where the header used to say "Stopped" with Start enabled.

Not answering goes back to Running on the first answered fast check (0.1 s in the run kept here, before any `status --json` run had finished). When the process ends, the header says Stopped at once.

A gateway this window did not start is as before: it answers, the header says Running with Start off and Stop on, and Stop stops nothing and writes "The running gateway was not started by this window. Stop it from the window it was started in." to the log. When it stops answering the header says Stopped, Start on, Stop off.

### B. Layout at every size

Files: `../responsive/` (231 captures, `results.txt`, and `results-before-fixes.txt` from the source before any layout change).

Before: 212 captures, 1009 of 1272 program checks passed, 2 captures clean. After: 231 captures, 1615 of 1617 program checks passed, 229 clean. The before run had six checks per capture and stopped at the third dialog on a mistake of the check program; the after run has seven (the seventh is the scroll range of a scrolling panel) and ten more captures (limits that arrive after the window was laid out).

Found and fixed:

- The bottom line (data folder, program folder, build) was two lines of text in a row one line tall, at every size. The row is now as tall as its text, a name stays with what it names, and the build is not left with one word on a line.
- Models: the row of suggestions was drawn over the top 62 px of the list. It now sits between the note and the list.
- The update line started 4 px left of everything else, and at 860 px its buttons were outside the window. The sentence wraps in front of the buttons, which stand under Start and Stop at every width.
- Account cards: "Active" was cut by 1 px at 860 px (in the baseline since 29693af), and a long e-mail pushed the plan and the state out of the card. The e-mail goes on a line of its own when the title line cannot hold it. The third column is one width in all cards, so the bars end on one line.
- Lanes at 860 px: lane names ended in dots and models that did not fit in the ladder were left out without a sign. The first column shows its text whole, and a ladder goes on two or three lines in a taller row.
- Models at 860 px: model names ended in dots. The first column shows them whole.
- DeepSeek Harness: four equal columns left 179 px for the one column that holds a sentence. The shares are now 220, 90, 90, 400.
- A line of text beside buttons stood 4.5 to 6 px above the middle of the buttons: the limits note, the models note, a suggestion, the device code of the sign-in dialog, the "Use a reset" button in its strip, and the two drop-downs on the API keys page.
- Notes that wrap ended in a line with one word on it at some widths. The last two words stay together.
- In a list with logos, a row without one started its text 28 to 32 px left of the others.
- The text of a switched-off button was the brightest on the page (the colour was given with transparency, which this text drawing ignores). It is a solid dim colour now. This is paint, not layout.
- In a short window the header chose between one and two status lines only when the window was resized. Text that came later (the lowest limit, the sentence of a state) kept the arrangement made for the old text. The header is laid out again when either changes.

One fault was of this batch's own making and was caught by the six-section check (148 differing pixels on Accounts after Chat, Video, Chat): a card that moved its e-mail while the list was being laid out left the list scrolling over the old height. The card is now changed after the list has finished, and the layout check has a scroll-range check that fails on the faulty version (11 lines).

Left as it is:

- Models at 860 px: "Reasoning" and "Status" still end in dots in the two captures that fail `text` (12 lines). Six columns do not fit in 796 px; the model name was given the room. All six are whole from 1177 px up.
- With folder names as long as the throwaway ones the bottom line is two lines at every width. That is the text, not the layout.

The pictures are what the desktop compositor holds of the window. 14 of 231 changed between two pictures 120 ms apart and were taken again until two in a row were the same: the two sign-in dialogs with a moving progress bar, and pictures taken right after the window shrank from 5120 px to 860 px, where the first one was a frame behind (a header not yet drawn, or 32 px of background one shade off). The saved picture is the stable one. An earlier run, before this was in the program, saved one picture with an empty header; none of the 220 window captures kept here has one (checked by counting bright pixels in the header band).

### Model ticks sent without a click

Files: `final-model-ticks-before.txt` (2 FAIL), `final-model-ticks-after.txt` (14 ok), `final-model-ticks-video-guard-removed.txt` (1 FAIL).

Found during the layout pass, fixed on the lead's word. This is a behaviour change, kept apart from the layout changes in the diff (`modelTicks` in `FillModels` and `OnModelChecked`, 9 lines).

Windows reports every tick again when it builds the list window, which is the first time the Models page is shown after the app started. `OnModelChecked` acted on each: with a running gateway it sent `POST models/choose {"id":...,"offered":true}` for every ticked row; with a stopped one it opened "Start the gateway first." once per ticked row. Now a reported tick that equals what the row was filled with, or was last changed to by the user, is ignored.

The check uses a stand-in gateway that writes the call to its log, and four rows of which three are ticked. Before: 3 calls when the page is shown. After: 0 when the page is shown, 1 for a tick taken off by hand, 1 for the tick put back, 0 when the list is filled again four times while the page is on screen, 0 after another page and back.

The other list with ticks that save something, Video models, already had the guard. The same check passes on it, and fails when the guard line is taken out (one `video settings set` run without a click). The other handlers on a tick change only the window ("Show hidden models", the Chat and Video switch, the choices of a dialog) or are wired after the box is set ("Start with Windows").

What the old behaviour did on a real install, from reading `src/daemon.js` and `src/models.js` (no real `settings.json` was read): for every row that was ticked when the page was first shown, the daemon added the ID to `models.extra`, saved `settings.json` and ran a DeepSeek Harness sync. Rows without a tick were not sent. An ID in `models.extra` changes nothing while the model is offered by default: `offered` is `!hidden && (byDefault || extra)`, and the reason "switched on" is given only when the model is not offered by default. It matters later: a model that stops being offered by default (an older generation, or no longer a chat model in the catalog) stays offered, shown as "Offered (you switched it on)".

### Reruns on the final source

- `app\build.ps1`: exit 0.
- Restart scenarios: 104 ok. Follow: 15 ok. Seam: 25 ok. Credentials: 43 ok. Six sections: 8 ok, 0 differing pixels of 1,126,400 on each.
- `final-process-count-hidden.txt`: 5 minutes hidden, 0 processes started, 0 command line runs begun, 390 ms of CPU for the window and everything it started.

### Not verified in this batch

- Item A and the late-stop scenarios run against the stand-in gateway. The running install, a real backend, provider traffic, a real Krea sign-in and the 300-second wait were not touched.
- The sizes are window sizes set off screen at 100 % scaling on this machine. No real monitor of those sizes, and no other scaling, was used.
- A list whose columns the user has dragged keeps the proportions it was dragged to; that path was read, not run.
- The keyboard part of the six-section check needs the focus and was not run.
- No independent review: this is a self-review.

## Last round: four low findings (22 Nov)

Source: `app/DSHProxyApp.cs` sha256 `06F82B14EB7F0FDE` (before: `A2DAEC76C0D9BD01`), `app/Skin.cs` `28E346D68F61115F` (before: `A69ECACD31419924`). Diff of this round alone: `.tmp/desktop-ui-0007-last.diff` (+119 -39).

Files: `last-round-scenarios-before.txt` (the new checks on the sources before this round: 106 ok, 10 FAIL), `last-round-scenarios-after.txt` (116 ok, 0 FAIL).

1. **What is asked follows what is shown.** The sentence "The gateway did not answer when it was last checked" is used only while the header says Not answering. With one or two missed checks the header still says Running, and Stop, Quit and the restart for a key change do what they do for a gateway that answers: nothing is asked with a count of 0, and the ordinary sentence with the count otherwise. Check: one missed check is given to the window and Stop or Quit pressed in the same turn of its thread. Before: Stop asked the "did not answer" question with a count of 0 and of 2. After: no question at 0, the ordinary sentence at 2, for Stop and for Quit.
2. **Starting ends.** A gateway this window started that is a live process and has not answered 30 seconds after its start is shown as Not answering. The header changes at the next missed check after the 30 seconds (the checks are 3 seconds apart with the window on screen, 15 when it is not), or at a full status. In that state Stop asks, with the "did not answer" sentence and no count: the rule of item 1, without a special case. Check: a stand-in gateway that is silent from its start: Starting, Not answering 32.6 s after Start, Running 2.9 s after it first answers. Before: still Starting after 50 s.
3. **The watch asks on its own thread.** When a gateway that was asked to stop at an idle moment ends late, the question whether another gateway has the address by now is asked by the watch's thread, and the window's thread starts the gateway with that answer if the watch is still the current one. The answer is not used if the address has changed meanwhile, or if the watch did not ask; the start then asks as before. Start from the button, the tray and a restart are unchanged. Check: the longest time the window's thread took to get to an empty call, from Cancel until the gateway was started again. Before: 1525 and 1535 ms. After: 1 and 3 ms.
4. **Chat > Models in a narrow window.** Where the six columns cannot all show their text, the Service column is left out (width 0) and the others share the room. The tip of each row says the service at every width ("claude-haiku-5-5  ·  Service: Claude"); the list did not show tips before. With the sample texts the five columns fit at 860x600, so no cell wraps and no wrapping was built. A user who drags a column gets the proportions back, the Service column included. Check: `../responsive/results.txt`, 231 captures, 1617 of 1617 program checks (before: 1615, the 12 failing lines were this page at 860x600). The layout check now takes a column of width 0 as left out and fails if a row's tip does not say what the column would.

Pictures: `../responsive/last-round-picture-comparison.txt`. Against the pictures kept before this round, Chat > Models is the same pixel for pixel at all nine sizes from 1177x618 up. Run on the sources before and after this round with the same check program, 220 of 231 pictures are the same; the two Models pictures at 860x600 are the change, one is a dialog with a moving bar, and eight (video-log) differ for the reason below.

Found on the way, not changed: after a resize the backdrop is never drawn again at the new size. The stretched copy that bridges the resize already has the new size, which the redraw timer takes to mean there is nothing to do (`Backdrop.Schedule`, since e44910b). A resized window keeps a backdrop stretched once per size it was painted at; which sizes those are depends on timing, so two runs of the same sources can differ all over the window. That, not this round's change, is why 167 other pictures differ from the kept set. The fix is small, but it changes every picture at every size, so it was left for a decision.

Reruns on the final sources: `app\build.ps1` exit 0; scenarios 116 ok; follow 15 ok; model ticks 14 ok; seam 25 ok; credentials 43 ok; six sections 8 ok with 0 differing pixels. The 5 minute process count was not asked for and not run again.

Not verified: that the tip appears on a real hover (the mouse was not moved; the check reads the tip's text and that the list shows tips); a list whose columns were dragged (read, not run); item 3 with an address that changes during the watch (read, not run); as before, everything runs against stand-in gateways and off-screen windows at 100 % scaling. Self-review only.

## The backdrop after a resize (22 Nov)

Source: `app/Skin.cs` sha256 `E048B035482B79E5` (before: `28E346D68F61115F`); `app/DSHProxyApp.cs` unchanged. Diff of this change alone: `.tmp/desktop-ui-0007-backdrop.diff` (+26 -2, all in `Backdrop`).

What was wrong: after a resize the window showed its old backdrop stretched to the new size, as a bridge, and a timer was to draw it properly 160 ms after the last step. The timer's test for "nothing to do" was that the kept backdrop has the size of the window, which the bridge always has. So the backdrop was never drawn again: a maximised window kept a stretched sky.

What changed: the app remembers which windows hold a bridge. When the timer fires, a bridge is replaced by a backdrop drawn at the real size, the old bitmap is disposed, and the timer is disposed. Every step of a resize starts the 160 ms again, so nothing is drawn while the window moves. For a window that is hidden or minimised when the timer fires nothing is drawn; the redraw is asked for again when that window is next painted while it can be seen.

Check program: `harness/BackdropCheck.cs` (run by `backdrop.ps1`), on the app's real window as a preview, off screen and never activated.

- `backdrop-sizes-before.txt` (15 FAIL) and `backdrop-sizes-after.txt` (19 ok). 860x600, 1280x880, 3440x1392 and 5120x1392, each from each of the others, twelve steps: before, 10,197 to 283,388 pixels differ from a backdrop drawn at that size and nothing was drawn; after, 0 pixels differ and it was drawn once at each. 40 steps 15 ms apart: drawn 0 times while moving, once when it had come to rest. Resized and hidden, or minimised, within the 160 ms: drawn 0 times in 1.5 s, no timer left; shown again: drawn once, 0 pixels differ.
- `backdrop-300-resizes-after.txt`: GDI objects 44 before and after, USER objects 118 before and after, private bytes 100.3 MB before and 101.9 MB after (102.6 before a collection), one backdrop kept, no redraw waiting. Before the change (`backdrop-300-resizes-before.txt`): 44 and 44, 100.1 and 103.0 MB.
- `backdrop-idle-after.txt`: 47 ms of processor time in the 60 s after a resize had settled (before the change: 16 ms), no redraw waiting in any of 60 looks.
- `../responsive/backdrop-in-pictures.txt`: two runs of the layout check on the same sources give 230 of 231 pictures the same pixel for pixel (the one that differs is a dialog with a moving bar). In all 88 pictures 1920 wide and wider the bare backdrop beside the page equals one drawn at that size; in the 88 kept before the change, none did.

The probe of the last round, a form that is never shown, still reports differing pixels on the fixed build (1973 of 78,156 sampled). That is the rule "nothing is drawn again while the window is hidden", not a failure; it is why the check above uses a window that is shown.

The pictures in `../responsive/` were all taken again in one run on the final sources: 231 captures, 1617 of 1617 program checks.

Reruns on the final sources: `app\build.ps1` exit 0; six sections 8 ok, 0 differing pixels (`backdrop-six-sections.txt`); seam 25 ok; 5 minutes hidden: 0 processes started, 0 command line runs, 265 ms of CPU (`backdrop-process-count-hidden.txt`). The restart scenarios, credentials and model ticks were not asked for and were not run again; `app/DSHProxyApp.cs` is unchanged since they passed.

Not verified:

- A window on a real screen. Windows asks a window at x = -12000 for no painting, so in every check the window painted because the check asked it to (PrintWindow, as for the pictures). That the app's own request to repaint after the redraw reaches the screen is read from the code (`form.Invalidate(true)`, unchanged), not seen.
- For the same reason the 60 s of idle time are those of a window that is asked for no painting. They show that no timer keeps running; they do not measure a window in view.
- A resize by dragging the edge with the mouse, where the app shows a snapshot of the whole window until the mouse is let go.
- Self-review only.
