# 0009 — On macOS the master key is wrapped through the Keychain

Date: 2026-11-23
Status: accepted for the macOS port (`docs/work/0014-macos-port`). Not chosen by the user in so many words: taken from "exactly the same as win" and from a proof on three Macs. Say so if a plain private file is preferred; it is one module to replace.

## Context

On Windows the master key in `master.key`, which encrypts the saved API keys, is wrapped with DPAPI for the current user. macOS has no DPAPI. Its counterpart, a secret tied to the user's login, is the Keychain.

## Decision

1. On macOS, `src/keywrap-darwin.js` keeps one random 32-byte wrapping key per user in the login Keychain as a generic password (service `DSHProxy`, account `key-wrapper`), made on first use. `master.key` holds the master key encrypted with it (AES-256-GCM, prefix `kc1:`). Windows is unchanged: DPAPI as before.
2. The Keychain is reached through `/usr/bin/security`, which is part of macOS. The key is written with `security -i` and the command on standard input, so it is in no argument list; the program gets only `HOME` in its environment. No compiled helper.
3. Every call ends after 10 seconds. A Keychain that cannot be read is an error with one sentence; nothing is written and no second key is made. Exit 44 ("no item") creates a key only when a new `master.key` is being made.
4. `DSHPROXY_KEYCHAIN` names another keychain file. Tests use throwaway ones and never a login Keychain; under the test runner the wrapper refuses to run without one.

## Consequences

- The wrapping key protects the copies of keys in `settings.json` and `video-keys.json`, as DPAPI does on Windows. It does not protect `backend-config.yaml` or `auth/`, which hold keys and sign-ins in plain text on both systems; on macOS they are private to the account (mode `600`, folders `700`).
- A program running as the same user can ask `security` for the wrapping key, as it can ask DPAPI on Windows. Its first use creates the item with `security` in the item's access list, so `security` reads it without a prompt.
- A locked login Keychain (some people set it to lock after a while) makes macOS show its password dialog. DSHProxy waits 10 seconds and says that the Keychain is locked. On a Mac with someone at the screen the dialog stays and blocks later calls on that keychain until it is answered (seen on 23 Nov).
- Not seen: what happens over SSH with nobody logged in at the screen.
- Copying the data folder to another Mac or account makes the saved keys unreadable there, as on Windows.
