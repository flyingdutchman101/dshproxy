# Desktop app: centered, responsive layout

Requested 2026-11-22: review size, design and responsiveness of the DSHProxy desktop app; everything centered; usable on 13, 14, 15, 16, 17, 24, 27, 34 and 49 inch monitors. Base `3f6eb33`, worktree `video-routing`. The running app is not replaced without the user's approval.

## Review evidence (build `3f6eb33`, preview mode, captures in `review/`)

Layout depends on effective resolution (pixels divided by Windows scaling), not on inches. Window sizes used below are the working areas of common setups.

1. Wide screens: nothing is centered and nothing has a maximum width. At 3440x1392 the title is at the far left, Start/Stop at the far right, lists span the full width with their columns in the left 600 px, account cards stop at about 1630 px and stay left (`review/chat-accounts-3440x1392.png`, `review/video-models-3440x1392.png`).
2. Start size is fixed at 1000x760 on every screen. A 13 or 14 inch 1080p laptop at 150% has a working area of about 1280x672, so the window opens taller than the screen.
3. Short screens: header, workspace bar, section strip, note, button row and footer take about 400 px. At 1366x728 two account cards fit (`review/chat-accounts-1366x728.png`).
4. List columns have fixed pixel widths and do not follow the list width.
5. The process is DPI-unaware (measured: awareness 0). On a scaled display Windows stretches the window as a bitmap, so text is soft on most 13 to 16 inch laptops. Not fixed in this change: see Non-goals.

## Behavior

- Centered column: header, workspace switch, section strip, pages, button rows and footer sit in one horizontally centered column of at most 1240 px. The backdrop still fills the window. Narrower windows use the full width with the existing side padding.
- The workspace switch and the section strip are centered in the column. Tables and cards keep left-aligned text inside the column.
- Start size follows the screen the window opens on: at most 1280x880, never more than 92% of the working area, centered. The minimum size never exceeds the working area.
- Short windows (client height under 760): the header is lower and the workspace switch shares one row with the section strip when the column is wide enough; the workspace description line is dropped in that mode. At 1280x672 the list or card area alone (not counting the page note and its button row) is at least half of the client height. When they share a row, the switch and strip are centered as a pair.
- List columns fill the list width in proportion to their designed widths (re-based when the user drags a column), with a minimum each, and follow resizing. No horizontal scrollbar when the columns fit.
- Account cards use the full column width.
- Chat and Video behave the same; switching workspace or section never changes the layout frame. Resizing does not flicker more than today (the resize preview stays).

## Non-goals

- DPI awareness (crisp text on scaled displays). It changes every hardcoded pixel metric in two custom-drawn files and cannot be checked on this machine, where both displays run at 100%. Separate change, with a check on a scaled display.
- Remembering the last window size and position.
- New features, copy changes, settings or CLI changes.

## Verification

Preview mode only (`--preview-limits app\preview-limits.json`, optional `--workspace video`, `--tab N`). Capture and inspect Chat Accounts, Chat Lanes, Chat Models, Video Models and Video Lanes at 860x600 (minimum), 1280x672, 1366x728, 1536x824, 1920x1040, 2560x1392, 3440x1392 and 5120x1392, plus the start size. For each: column centered (equal left and right margins within 1 px), no clipped or overlapping control, no horizontal scrollbar, keyboard order unchanged. `npm test` and `npm run check` stay green; the app compiles with `app\build.ps1`.
