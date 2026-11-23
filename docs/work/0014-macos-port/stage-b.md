# Stage B — video on macOS: criteria and plan

Status: written on the Mac on 23 Nov, after stage A's code was done. **For the user to read.** Not reviewed yet. Facts it rests on: `research/facts.md` sections 6 to 8; design of the video picker: `docs/work/0011-video-in-model-picker/` on branch `work-documents`; decisions 0002 to 0008.

## What works afterwards

On macOS, as on Windows: `dshproxy video quote|submit|status|krea|balance`, `dshproxy video picker`, the paid entries in the Harness model picker (quote, then a bare `yes` buys one clip, purchases off until switched on, the 24-hour ceiling), and the Krea sign-in with renewal (`dshproxy-krea login|status|logout`). Not in stage B: the app's Video page (stage D), the video tools plugin (stage C).

## What is Windows-only today, and what changes

| Part | Windows today | macOS in stage B |
|---|---|---|
| Krea sign-in store (`src/krea-helper/oauth.js`) | `windowsStore`: `<LOCALAPPDATA>/DSHProxy/KreaOAuth/session.v1`, file key wrapped with DPAPI | a store with the same code and file format in `~/Library/Application Support/DSHProxy/KreaOAuth/` (folder `0700`, file `0600`), file key wrapped with the macOS key wrapper of stage A (`src/keywrap-darwin.js`); `windowsStore` unchanged |
| The helper's environment (`src/video/workspace.js`) | `SystemRoot, LOCALAPPDATA, TEMP, TMP, USERPROFILE` | `HOME, TMPDIR`, and `DSHPROXY_KEYCHAIN` when set |
| The picker's child (`src/video/picker/child.js`) | `SystemRoot, LOCALAPPDATA, APPDATA, TEMP, TMP, USERPROFILE, DSHPROXY_HOME`, plus the three key variables on API routes | `HOME, TMPDIR, DSHPROXY_HOME`, and `DSHPROXY_KEYCHAIN` when set, plus the same three key variables on API routes |
| Video keys | master key through DPAPI | master key through the Keychain (stage A, done) |
| The purchase journal (`store.js`) | `fsync`; creation-time rule for NTFS | unchanged code. Node asks macOS for a full flush (`F_FULLFSYNC`, `research/facts.md` section 8). APFS gives a re-made file a new creation time (proof, F5); the rule is then simply never the limiting one |
| The not-yet gates of stage A | — | removed for `video` and `krea` (`src/not-yet.js`), with the macOS skips that name stage B |

Nothing else in the video code was found to depend on Windows.

## Acceptance criteria

Automatic, on a Mac and in CI (both processors):

- **B1.** The Krea store on macOS saves, loads and clears a session; the file is in `~/Library/Application Support/DSHProxy/KreaOAuth/`, the folder `0700`, the file `0600`; its content holds no token in the clear; it cannot be read with another wrapping key. Tested with the store's `protect` replaced and with the real key wrapper on a throwaway keychain.
- **B2.** Every test of the Krea store and of renewal that runs on Windows runs on macOS against the macOS store (`krea-renewal-process.test.js`, `krea-renewal.test.js`, `krea-oauth.test.js`), and passes: two helpers renew once, a dead helper's lock is taken over, a live one's is kept, sign-out waits, consent holds nothing.
- **B3.** The helper and the picker's child get exactly the macOS list of variables (and the key variables only on API routes); no other variable of the gateway reaches them. The Windows lists are unchanged (existing tests).
- **B4.** Every video test that is skipped on macOS today naming stage B runs on macOS and passes; `test/not-yet-darwin.test.js` loses its video and Krea cases and keeps the plugin-install cases (stage C).
- **B5.** The purchase journal's own tests (one purchase per quote, the multi-process ones included) pass on macOS, unchanged.
- **B6.** On Windows nothing changes: the suite runs at least the tests it runs now, all pass; the compatibility test with `main` passes.

By hand, on the user's Mac (needs the user):

- **BM1.** `dshproxy-krea login` opens Krea's consent page; the user signs in; `dshproxy-krea status` says signed in. *(The sign-in is the user's.)*
- **BM2.** `dshproxy video quote seedance-2.5 krea --prompt "..."` returns a free preflight.
- **BM3.** In the Harness model picker, a video entry, with purchases off: a prompt gets a quote, `yes` rehearses and buys nothing.
- **BM4.** Only on the user's word for that one purchase: one real clip.

## Plan

Mode: cheap, inline, red before green, one review at the end of the stage.

- **B0 — facts.** Done: `fsync` (facts section 8), creation time on APFS (proof F5), the Windows-only parts (table above).
- **B1 — the Krea store on macOS.** `src/krea-helper/oauth.js`: the store's body taken out of `windowsStore` into one function that takes its folder and `protect`; `windowsStore` calls it exactly as before; a new `macStore` calls it with the macOS folder and the key wrapper. `bin/dshproxy-krea.js` picks the store by system. Tests: B1, then B2 by running the renewal tests against `macStore` on macOS (their Windows runs unchanged).
- **B2 — the children's environments.** `src/video/workspace.js`, `src/video/picker/child.js`: the list by system. Tests: B3.
- **B3 — the gates go.** `src/not-yet.js` loses `video` and `krea`; the macOS skips naming stage B are removed; the gateway mounts the picker; `app.videoModels` offers entries. Tests: B4, B5, whole suite on the Mac and in CI.
- **B4 — review and the checks by hand.** One independent review of stage B's diff; then BM1 to BM3 with the user; BM4 only on the user's word.

## Open with the user

- Whether to read this plan before it is built, or to let it be built and review the result. Building it changes no Windows behaviour and buys nothing; BM1 to BM4 need the user in any case.
