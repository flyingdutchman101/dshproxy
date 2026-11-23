# New models at the providers DSHProxy uses, 2026-11-22

Asked 22:15: "check for any new models by any providers we have". Two read-only web checks (`chat-providers.md`, `video-providers.md`, each with the pages opened) and the lead's own reads of the running install.

## Chat

Read from the running install at 22:20 (`dshproxy status --json`, `models`, `dsh verify`, `dsh apply --dry-run`):

- The gateway's own check ran at 22:15:29 with no catalog error. Backend CLIProxyAPI 8.1.1, no newer release.
- 26 models are offered (5 lanes, 8 Claude, 7 ChatGPT, 6 through API keys). Both DeepSeek Harness profiles (`desktop`, `web`) hold exactly these; verify says ready, a dry run of apply would change nothing.
- Served by the accounts and not offered, by design: older generations, image models (`gpt-image-2.5`, `gpt-image-2.6` and variants), `gpt-6-chat-thinking` (switched off by the user).

From the providers' pages:

| Provider | Newer than what we offer | Source |
|---|---|---|
| Anthropic | nothing; newest is `claude-fable-5-2` (2026-11-09), offered | platform.claude.com models overview |
| OpenAI | nothing; newest are `gpt-6.2-sol` and `gpt-6.2-astra` (2026-11-17), offered | OpenAI models and Codex models pages |
| DeepSeek API | nothing; the two listed models are the two we offer | api-docs.deepseek.com pricing, change log |
| Qwen Token Plan | **`qwen4-max`**, added 2026-11-16 for Individual and Team (lead opened the product-updates page itself) | docs.qwencloud.com/token-plan/token-plan-product-updates |

The Qwen list in `src/catalog.js` is hand-written, so `qwen4-max` appears only after a code change. Not verified: that the user's key serves it, and its figures on the plan (the general model page says 1,000,000 context, 131,072 output).

The same Qwen page lists `wan3.0-video` on the Token Plan since 2026-10-10: a possible further route for Wan 3.0, not examined.

## Video

None of the five catalog models was renamed or retired, and the per-clip prices in `src/video/catalog.js` match today's pages. New on the routes we have (5 s, 720p unless said; published prices, not charged ones):

| Model | VideoRouter | KovAPI | Callirra | Krea (API price) |
|---|---|---|---|---|
| Seedance 2.5 Flash | $0.60 | $0.60 (listed 2026-11-19) | | |
| Wan 3.0 Prime | $0.41 | $0.60 (paused 2026-10-26, no notice that it is back) | | $0.70 |
| Flux 3 Max | $0.87 | | | $0.85 |
| MiniMax H3 Max / Max Turbo (768p) | $0.33 / $0.21 | | | $0.30 / $0.15 |
| MiniMax H3 Lite (768p) | | $0.0625 | | |
| Kling 4.0 | $0.68 | removed 2026-10-28 | 30 credits | $0.785 |
| Gemini Omni 1.2 Flash | $0.31 | $0.175 | | no fixed price |
| Grok Imagine Video 1.5 | | $0.20 | 23 credits (preview) | |

Changes to ours: KovAPI cut Seedance 2.0 to $0.105 per second on 2026-11-21 and reports 51.4% success over 7 days for it; Krea's Seedance 2.5 gained 4K and a draft mode on 2026-11-15. `videorouter.ai` is a parked domain; the service is `videorouter.sh`.

Not verified: Krea's compute-unit prices for the new models on the sign-in route (needs a sign-in), any keyed catalog, whether a listed model accepts jobs.
## Done about it (22:41)

- `qwen4-max` added to the Token Plan and pay-as-you-go lists (`ed0f03b` on `main`, pushed, CI success): two tests red before, `node --test` 566 of 566 in the main checkout. After the restart at 22:40:49 the install offers 27 models, both DeepSeek Harness profiles were updated by the gateway itself (compat route 6 to 7 models) and `dsh verify` says ready.
- Not done: a request to `qwen4-max` with the user's key. DeepSeek Harness has to be restarted before the model shows in its picker.