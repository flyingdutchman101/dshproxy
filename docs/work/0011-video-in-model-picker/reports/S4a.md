# Report: S4a — the paid video route in the DeepSeek Harness profile

Status: DONE_WITH_CONCERNS. Branch `picker-profile`, on top of `e21520a`. Nothing committed.

## Files changed

- `src/dsh/profile.js` (164 lines added, 23 removed)
- `test/profile-video.test.js` (new, 33 tests)
- `docs/work/0011-video-in-model-picker/reports/S4a.md` (this file)

`test/profile.test.js` is not edited.

## What was built

All in `src/dsh/profile.js`, through the existing public functions plus one new export.

1. **The route.** `ROUTES` has a fifth entry, `dshproxy-video`: api `video`, protocol `anthropic-messages`, suffix `/dshproxy/video`, label `DSHProxy · Video (paid)`, `options: { streamIdleTimeoutMs: 900000, retryPolicy: { mode: "normal", maxRetries: 0 } }`. `buildRoutes` copies `route.options` into the route it builds. A route without `options` gets no extra key, so the four chat routes are built as before.
2. **Its models.** A model with `api: "video"` matches the video route's `api` and no other, by the filter `buildRoutes` already had. The video route ignores `keepModelPrefixes`: an entry that is not passed is never kept.
3. **`apply`.** Writes the route with the passed entries in the passed order; removes it when none is passed (the existing "route with no models" branch). It never writes `allowedModels` or a tool row (it did not before, and still does not). A default model whose provider is `dshproxy-video`, or whose model is a video entry id under a chat provider, is repaired by the existing repair. `--dry-run` reports the route in `routes` and in `changed` like the others.
4. **`verify`.** New reports:
   - entries differ: `dshproxy-video does not list <ids>; run \`dshproxy dsh apply\` to add it`, `dshproxy-video lists video entries that are no longer offered: <ids>; run … to remove it`, `dshproxy-video lists its entries in another order than they are offered; run …`, `route dshproxy-video is missing (it should list <ids>); run …`, and `dshproxy-video is in this profile with <ids>, but no video entry is offered; run … to remove it`;
   - `dshproxy-video.retryPolicy.maxRetries is 5, expected 0 (a paid request must not be sent again automatically); run \`dshproxy dsh apply\`` (also `is not set`);
   - one line per place that names the route outside the provider list: `<entry id> at <path> names dshproxy-video/<model>: the paid video route must not be selectable for agents or be the default model. Remove it there.` Examples of the place: `subagent-model-selection-settings at config.allowedModels[2]`, `tool-reviewer at config.agentOptions`, `agent-default-model at config`. An entry without an id is `the profile at entry 5.settings.pick`.
   - The video route still gets today's route checks (`baseURL`, `apiKeyEnv`, image caps).
5. **`remove`.** Deletes the video route with the other four (the loop over `ROUTES`).
6. **`videoExposed(home)`**, exported. True when any profile names provider `dshproxy-video` outside its provider list. It reads only.

### Where the route options are written, and why

At the top level of the route, beside `baseURL` and the image caps:

```yaml
      dshproxy-video:
        displayName: DSHProxy · Video (paid)
        apiKeyEnv: DSHPROXY_API_KEY
        api: anthropic-messages
        baseURL: http://127.0.0.1:8417/dshproxy/video
        maxRequestImages: 12
        maxRequestImageBytes: 8388608
        streamIdleTimeoutMs: 900000
        retryPolicy: { mode: normal, maxRetries: 0 }
        models:
          - id: seedance-2.5/720p/krea
            name: Seedance 2.5 - 720p - Krea
            input: [ text ]
            contextWindow: 1000000
            maxTokens: 4096
            reasoningEfforts: false
```

`dsh-model-facts.md` section 1 lists `streamIdleTimeoutMs` and `retryPolicy` among the route's own fields, and the existing code writes every route setting at that level. The two agree; there was nothing to choose between. The image caps are written as on the other routes (design 2.3), so `verify` treats all routes alike.

## Red before green

Tests were written first and run against the unchanged module (`e21520a`): 33 tests in the final file; at the red run there were 32 (the linked-profile test was added with the implementation).

```
# tests 32
# pass 3
# fail 29
```

Failures by message (unchanged module):

- `profile.videoExposed is not a function`: every exposure test (15 to 21, 27 to 32).
- `Cannot read properties of undefined (reading 'models')` / `(reading 'retryPolicy')`: tests that read the video route after `apply` (9, 13, 22).
- `ERR_ASSERTION`: route written (2), chat routes unchanged beside it (4), entries added/removed/reordered (5), missing or left-over route (6), video entry on a chat route (7), route removed (8), default named a video entry on a chat route (12), each exposure place (14), dry run (23), remove (24, 25).
- `Missing expected exception.`: video entries alone (10).
- `'the route itself stays'`: default on the video route (11).

Three passed before the change, and why:

- "a profile without video entries is written byte for byte as before the video route existed": it is the pin of the unchanged behaviour.
- "a freshly applied profile with video entries verifies as ready": the unchanged code ignores the entries.
- "another program's route with a similar name is left alone": the unchanged code does not know the name.

Test 11 failed in red only on its last-but-one assertion; the unchanged code already repaired that default, because `dshproxy-video` was an unknown provider. With the route in `ROUTES` that would have stopped. The mutation run below shows the test now fails when the new guard is taken out.

Green:

```
node --test test/profile-video.test.js test/profile.test.js
ℹ tests 73   ℹ pass 73   ℹ fail 0

node --test
ℹ tests 659  ℹ pass 659  ℹ fail 0  ℹ skipped 0

node scripts/check.js
74 files OK        (exit 0)
```

Every run had `DSH_HOME` and `DSHPROXY_HOME` set to folders under `%TEMP%`; those two folders were never created. The test file also sets both to throwaway folders of its own and fails if anything appears in them.

### Mutation check

Each line taken out of `profile.js` in turn, both profile test files run, file restored (checked equal to the original):

| Removed | Tests that fail |
|---|---|
| default guard (`defaultProvider !== VIDEO_ROUTE`, chat ids only) | 2 |
| video entries never kept | 1 |
| linked profile folders searched | 1 |
| references (`*name`) followed | 1 |
| no old name for the video route | 1 |
| video entries alone are not models | 1 |
| unlistable profiles folder is exposed | 1 |
| unreadable profile is exposed | 3 |
| default on the video route reported once | 2 |
| video pairs left out of the "does not define" check | 1 |
| video ids not offered on chat routes | 2 |
| provider list not searched | 1 |
| options written into the route | 16 |

## How each criterion is covered

| Criterion | Test |
|---|---|
| Bytes identical without video | "a profile without video entries is written byte for byte as before the video route existed" (fixture produced by running `e21520a`); "applying without video entries removes the video route and changes nothing else" (ends on the same fixture); "video entries go to the video route only and leave the four chat routes as they were" (the written text minus the video route equals the fixture) |
| Route written with options and entries | "the video route is written with its address, its options and the passed entries" |
| Entries added, removed, reordered: apply and verify | "verify reports entries that were added, removed or reordered, and apply picks each change up"; "verify reports a profile that lacks the video route while entries are offered, and one that keeps it when none is" |
| No entries removes the route | "applying without video entries removes the video route and changes nothing else" |
| Default model on the video route repaired | "a default model on the video route is repaired to a lane"; "a default model that names a video entry on a chat route is repaired too" |
| Never in `allowedModels` or a tool row | "applying never names the video route in the allowed models or in a tool" |
| Verify reports each exposure place separately | "verify reports each place that names the video route, separately"; four tests "the video route named in … is reported by verify and counts as exposed" |
| `maxRetries` not 0 | "verify reports a video route that would be sent again automatically" |
| Remove deletes it | "removing takes out the video route with the other four"; "removing a profile that holds only the video route leaves the file as it was" |
| `videoExposed` true per place | the four "… counts as exposed" tests; "… although the profile no longer has the route"; "a pair that is written once and reused by reference is found where it is used"; "a profile that is a link to a folder elsewhere is searched too" |
| `videoExposed` false for a clean profile, writes nothing | "a clean profile is not exposed, and asking writes nothing"; "the provider list and the tool bundle's own entry are not exposure"; "a home without profiles is not exposed, and asking creates nothing" |
| `videoExposed` true for an unreadable profile, writes nothing | three tests "a profile that (has YAML errors / is not a list of entries / cannot be opened as a file) counts as exposed, and asking writes nothing"; "a profiles folder that cannot be listed counts as exposed" |
| Dry run | "a dry run reports the video route and writes nothing" |
| No existing test edited; suite and check pass | see Green |

## Decisions the brief left open

1. **Video entries alone.** `apply` threw "No models are available yet" for an empty list. A list holding only video entries would have passed that check, removed all four chat routes and left a profile whose only route is the paid one. `apply` now throws the same message when no chat model is passed. For input without video entries nothing changes.
2. **A video id is not a chat model.** In `verify`, video ids are no longer "offered" for a chat route, a lane or the default model; in `apply`, a default that names a video id under a chat provider is repaired. Otherwise `{ provider: dshproxy-claude, model: seedance-2.5/720p/krea }` would have verified as fine.
3. **One report per cause.** A default on the video route gets the exposure line only, not also "not offered". A `{ provider: dshproxy-video, model }` pair that the profile does not define gets the exposure line only, not also "does not define (the tool would fail)". Before this slice such a pair got the second message; that is the one message that changed for an existing case.
4. **`dshgate-video`.** The four chat routes had old names (`dshgate-*`) that `apply` and `remove` delete. The video route never had one, so `dshgate-video` is not touched.
5. **Doubt counts as exposed** in `videoExposed`: YAML errors, a file that is not a list, a file that cannot be opened, a `profiles` folder that cannot be listed (missing is "no Harness": false), a profile searched past 200,000 nodes. A profile folder that is a link (junction) is searched, although `apply` and `verify` skip such folders today.
6. **References.** A pair written once with `&name` and used with `*name` or `<<` is reported where it is used, including when it was written inside the provider list.
7. **What counts as naming the route.** A mapping with `provider: dshproxy-video`, with or without `model`. The bare word elsewhere is not counted: `src/dsh/bundle.js` writes a patch entry `- id: dshproxy-video` for the tool bundle, which names no provider (tested).

## Where the design did not fit the code, and concerns

1. **Design 10 says the loops over `ROUTES` cover the route "without further change".** Three things needed a change: the default-model check (it accepts any id written to any route, so video ids had to be taken out), `keepModelPrefixes` (it would have kept a switched-off entry whose id starts with a kept prefix), and the old-name handling (point 4 above).
2. **User-added fields on a video entry are carried over** as on the other routes, and an `input` the user set on an entry wins. So "exactly the passed entries" holds for which entries and in which order, and for a fresh route; a field a person added by hand to an entry stays. If the route must be rewritten field for field, that is a two-line change; say so.
3. **The default is repaired only when the caller passes `lanes`**, as today. `cli.js` does; `daemon.js` `syncNow` does not, so an automatic sync leaves a default on the video route in place. `verify` reports it and `videoExposed` is true meanwhile.
4. **Until the callers pass video entries**, every `apply` (including the daemon's automatic sync) removes a video route it finds, and `verify` reports one as left over. That is point 3 of the brief working as written; the caller slice has to land together with anything that writes the route.
5. **Not verified in a real Harness**: that `streamIdleTimeoutMs` and `retryPolicy` load at this place. The facts file marks its own excerpt "not loaded". Nothing here ran against a real profile or DeepSeek Harness.
6. **`videoExposed` reads `cordis.patch.yml` of each profile only**, as `verify` does. The facts file (section 9) says `allowedModels` is copied into each new session; a session started while the route was listed is not seen here.
7. **Test count.** The brief gives 627 before the change. Here the full run is 659 with 33 new tests, which makes 626 others. No test is skipped or removed; I did not run the suite on a clean checkout to find the one.
8. `state()` now lists the video route among a profile's routes, so `src/cli.js`, which prints what `state()` returns, will show it without being changed. `hasRoutes` counts a profile that holds only the video route as applied.
