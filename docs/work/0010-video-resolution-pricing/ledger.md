# Video prices by resolution: ledger

Requested 2026-11-22 13:38: "video models, I want you to run analysis and see the pricing for 480 720 (or 768) and 1080 pricing". Analysis only; nothing is built, no sign-in, no key, no paid or authenticated call.

Reference clip: 5 seconds, 16:9, text-to-video, no reference input, no audio add-on (what `src/video/catalog.js` prices today at 720p, or 768p for MiniMax H3).

| Gate | Status | Evidence |
|---|---|---|
| Part 1: VideoRouter, every host per model (`price-videorouter`) | done 13:47 | `part1-videorouter.md` |
| Lead's check of part 1 on the primary source | done 13:52 | below |
| Part 2: KovAPI, Callirra, Krea, makers' list prices (`price-others`) | done 13:58 | `part2-kovapi-callirra-krea.md` |
| Lead's check of part 2 | done 14:02, KovAPI and Callirra credits only | below |
| Combined table and observations | done 14:05 | `report.md` |

## Lead's check of part 1 (13:52)

Fetched `https://videorouter.sh/pricing-index.json` (states `"generated":"2026-11-22"`, list prices before the platform fee, `platform_fee_rate` 0.025) and compared with the report's tables for the four models:

- Seedance 2.5: SoCheap-Overseas has one rate, 720p 0.137; BotSmart 0.0799 / 0.1794 / 0.4435. Match.
- Seedance 2.0: SoCheap-Overseas 720p 0.0896 only; BotSmart 0.0549 / 0.1181 / 0.2968. Match.
- Wan 3.0: BotSmart 0.0221 / 0.0441 / 0.0882; Replicate 0.025 / 0.05 / 0.1. Match.
- MiniMax H3: kie.ai 768p 0.04 (and 1440p 0.065, shown as "2K" on the pages); Atlas Cloud 480p 0.038, 768p 0.08, 1080p 0.08; WaveSpeedAI 480p 0.04, 768p 0.08, 1080p 0.16; MachGen 480p 0.044; Fal 480p 0.05. Match.
- The cheapest host per resolution in the report follows from these rates.

Not rechecked by the lead: the docs quotations (soft pin, silent fallback to a model default on an unsupported resolution, refund of failed jobs), the per-host accepted values and defaults read from page scripts.
## Lead's check of part 2 (14:02)

- KovAPI: fetched `https://docs.kovapi.com/<model>/md` for the four models. Per-second rates 480P / 720P (768P) / 1080P: Seedance 2.5 $0.10 / $0.158 / $0.38; Seedance 2.0 $0.07 / $0.105 / $0.25; MiniMax H3 $0.015 / $0.025 / $0.036; Wan 3.0 $0.04 / $0.065 / $0.13. Defaults: resolution 720P when omitted, except MiniMax H3 "1080P when omitted"; duration 4 when omitted for Seedance 2.5 and Wan 3.0, 5 for the other two. All as the report says.
- Callirra: `https://callirra.com/credit-costs` lists MiniMax H3 Standard at 5, 10 and 15 credits for 5 s at 480P, 768P and 1080P. As the report says.
- Not rechecked by the lead: Callirra plan prices, everything about Krea, the makers' list prices.
- The combined figures in `report.md` were recomputed by the lead from the rates above (per-second rate x 5, x 1.025 for VideoRouter).

Next step: none unless the user wants a resolution choice built. That would be a catalog change (a price and, on VideoRouter, a pinned host per resolution) plus the request bodies in `src/video/transport.js` and the Krea preset.
## Addendum (14:15)

User, 14:05: "Make me a side by side table like you did, just also add protoface and krea". The lead read Protoface's four model pages and `llms.txt` directly and rechecked two Krea API pages and the plan counts on Krea's pricing page; table and sources appended to `report.md`. Protoface is not a route in the app.