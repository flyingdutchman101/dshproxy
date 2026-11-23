# Video prices at 480p, 720p/768p and 1080p

Checked 2026-11-22 on public pages only. No sign-in, no key, no job, nothing spent: every figure is a published price, not an invoice. Details and sources: `part1-videorouter.md`, `part2-kovapi-callirra-krea.md`.

Clip priced: 5 seconds, 16:9, text-to-video, no reference input. US dollars. VideoRouter figures include its 2.5% platform fee.

## Seedance 2.5

| Route | 480p | 720p | 1080p |
|---|---|---|---|
| VideoRouter, cheapest host | **$0.409** (BotSmart) | **$0.702** (SoCheap-Overseas) | $2.273 (BotSmart) |
| VideoRouter, BotSmart at all three | $0.409 | $0.919 | $2.273 |
| KovAPI | $0.50 | $0.79 | **$1.90** |
| Krea workspace units | not published | about $0.56 to $2.17 (derived, see below) | not published |
| BytePlus list price | $0.514 | $1.156 | $2.843 |

## Seedance 2.0

| Route | 480p | 720p | 1080p |
|---|---|---|---|
| VideoRouter, cheapest host | **$0.281** (BotSmart) | **$0.459** (SoCheap-Overseas) | $1.521 (BotSmart) |
| VideoRouter, BotSmart at all three | $0.281 | $0.605 | $1.521 |
| KovAPI | $0.35 | $0.525 | **$1.25** |
| Krea workspace units | not published | not published | not published |
| BytePlus list price | $0.35 | $0.76 | $1.87 |

## Wan 3.0

| Route | 480p | 720p | 1080p |
|---|---|---|---|
| VideoRouter, BotSmart | **$0.113** | **$0.226** | **$0.452** |
| VideoRouter, Replicate | $0.128 | $0.256 | $0.513 |
| KovAPI | $0.20 | $0.325 | $0.65 |
| Krea workspace units | not published | not published | not published |
| Alibaba list price (before a "30% off for a limited time") | $0.25 | $0.50 | $1.00 |

## MiniMax H3 (768p in place of 720p)

| Route | 480p | 768p | 1080p |
|---|---|---|---|
| Callirra, plan credits (5 / 10 / 15 credits) | **$0.041 to $0.062** | **$0.083 to $0.124** | **$0.124 to $0.186** |
| Callirra on the monthly Pro plan at full use | $0.050 | $0.100 | $0.150 |
| KovAPI, pay per use | $0.075 | $0.125 | $0.18 |
| VideoRouter, cheapest host (not used by the app today) | $0.195 (Atlas Cloud) | $0.205 (kie.ai) | $0.410 (Atlas Cloud) |
| Krea workspace units | no resolution choice | about $0.31 to $1.20, one fixed tier (derived) | no resolution choice |
| MiniMax list price | not published | $0.40 | not published |

The Callirra range is the cheapest monthly plan (Max-L, $149.00 for 18,000 credits) to the dearest (Starter, $9.90 for 800), each at full use of the plan. Unused credits make a clip dearer. Callirra allows 1080P up to 10 seconds, the other two up to 15.

## What the numbers say

1. **The cheapest route changes with resolution for Seedance.** At 480p and 720p VideoRouter is cheapest; at 1080p KovAPI is cheaper by about 16% (2.5) and 18% (2.0). For Wan 3.0, VideoRouter's BotSmart is cheapest at all three; for MiniMax H3, Callirra, then KovAPI.
2. **On VideoRouter the cheapest host changes too.** SoCheap-Overseas, the host the app uses for Seedance, offers 720p only. At 480p and 1080p the cheapest host is BotSmart, which at 720p costs about 31% more than SoCheap-Overseas.
3. **Cost of going up or down from 720p/768p** (KovAPI, which publishes all three for every model): 480p costs 60 to 67% of it; 1080p costs 2.4 times for Seedance, 2 times for Wan 3.0 and 1.44 times for MiniMax H3. On VideoRouter 1080p Seedance is about 3.2 times the 720p price, because the cheap 720p host has no 1080p.
4. **The app's catalog is correct for the one resolution it holds.** All nine catalog figures (four VideoRouter, four KovAPI, one Callirra) reproduce from today's pages.
5. **Krea cannot be priced per resolution from public pages.** It publishes only how many videos a plan gives, for two of the four models at one setting; units per clip are not published. The dollar ranges above are derived from those counts and the plan prices and are not published prices. Its MiniMax endpoint has no resolution selector. A promotion on its pricing page ends 2026-11-24 08:00 UTC; prices after that are not published. Real numbers need the signed-in preflight.

## Traps if the app offers a resolution choice

- **VideoRouter does not reject an unsupported resolution.** Its docs say the value is "silently ignored (model default used), never a 400". Some hosts default to 1080p or 2K. A 480p or 1080p request pinned to SoCheap-Overseas is undocumented. The app already pins one host with fallbacks off, so each resolution would need its own pinned host, taken from the price index, never a guess.
- **KovAPI's MiniMax H3 renders 1080P when `resolution` is omitted**, and Seedance 2.5 and Wan 3.0 run 4 seconds when `duration` is omitted. The app sends both today, so it is not affected; it must keep doing so.
- **KovAPI and Callirra refuse an invalid resolution before a job exists** (HTTP 400, no charge). KovAPI wants upper case with the P (`720P`).
- **Published is not always charged on VideoRouter:** the final charge is the host's actual cost, and a model/host suffix alone is only a preference.

## Checked by the lead on the primary pages

- VideoRouter: the per-second rates of the hosts named above against `https://videorouter.sh/pricing-index.json` (dated 2026-11-22, fee rate 0.025). Match.
- KovAPI: all twelve per-second rates, the supported resolutions and the defaults against `https://docs.kovapi.com/<model>/md`. Match.
- Callirra: 5 / 10 / 15 credits for MiniMax H3 at 480P / 768P / 1080P against `https://callirra.com/credit-costs`. Match.

## Not verified

- Krea in any form, the makers' list prices, Callirra's plan prices, and the VideoRouter docs quotations: these rest on the researchers' reading and were not rechecked by the lead.
- Supported durations per VideoRouter host; whether each accepts 5 seconds without rounding.
- Any audio surcharge on VideoRouter hosts: none is shown, none is ruled out.
- Whether the 480p and 1080p outputs are true renders or upscales on any route.
- Charged amounts: no job was run.

Nothing in the app was changed. The catalog (`src/video/catalog.js`) still holds one resolution per model.

## Addendum, 14:15: Protoface and Krea side by side

Requested: the same side-by-side table with Protoface and Krea added. Protoface is not a route in the app today.

| Model | Route | 480p | 720p / 768p | 1080p |
|---|---|---|---|---|
| Seedance 2.5 | VideoRouter (cheapest host, fee included) | $0.41 | $0.70 | $2.27 |
| | KovAPI | $0.50 | $0.79 | $1.90 |
| | Protoface | $0.42 | $0.92 | $2.32 |
| | Krea API balance | "Variable", not published | not published | not published |
| | Krea workspace plan units | not published | about $0.56 to $2.17 (derived) | not published |
| Seedance 2.0 | VideoRouter | $0.28 | $0.46 | $1.52 |
| | KovAPI | $0.35 | $0.525 | $1.25 |
| | Protoface | $0.315 | $0.675 | $1.665 |
| | Krea API balance | $0.336 | $0.756 | $1.871 |
| | Krea workspace plan units | not published | not published | not published |
| Wan 3.0 | VideoRouter | $0.11 | $0.23 | $0.45 |
| | KovAPI | $0.20 | $0.325 | $0.65 |
| | Protoface | $0.25 | $0.50 | $1.00 |
| | Krea API balance | $0.375 | $0.75 | $1.50 |
| | Krea workspace plan units | not published | not published | not published |
| MiniMax H3 | Callirra (monthly Pro plan at full use) | $0.05 | $0.10 | $0.15 |
| | KovAPI | $0.075 | $0.125 | $0.18 |
| | Protoface | $0.05 | $0.18 | not offered (2K: $0.65) |
| | VideoRouter (not used by the app) | $0.19 | $0.21 | $0.41 |
| | Krea API balance | no choice | $0.65, one fixed tier | no choice |
| | Krea workspace plan units | no choice | about $0.31 to $1.20, one fixed tier (derived) | no choice |

Protoface, per output second for text-to-video without a video input, read by the lead on 2026-11-22 from the model pages `https://www.protoface.com/models/<slug>`: Seedance 2.5 $0.084 / $0.184 / $0.464; Seedance 2.0 $0.063 / $0.135 / $0.333; Wan 3.0 $0.05 / $0.10 / $0.20; MiniMax H3 480p $0.01, 768p $0.036, 2K $0.13 (also in `https://www.protoface.com/llms.txt`). Minimum billed duration 4 s on the Seedance pages and for H3, 2 s for Wan 3.0. The H3 page says "Round the total charge up to the next $0.01". Protoface's own comparison figures in `llms.txt` are dated 2026-11-09; the model pages carry no date.

Krea, rechecked by the lead on 2026-11-22: `https://www.krea.ai/docs/api-reference/video/wan-30.md` lists $0.075 / $0.15 / $0.30 per second; `minimax-h3.md` lists $0.65 for 5 s whatever the number of reference images and has no resolution property; `https://www.krea.ai/pricing` shows "Seedance 2.5 | 5s, 720p, no video reference | ~5 | ~23 | ~46 videos" and "Seedance 2.0 | 4s, 480p, video reference | ~40 | ~163 | ~327 videos" (the researcher's report says the first column was blank for both; it shows a count now). The Seedance 2.0 API rates and all plan prices were not rechecked by the lead.

What changes with these two added:

- Protoface is not the cheapest for Seedance or Wan 3.0 at any of the three resolutions. For Seedance 2.5 at 480p it is within 3% of VideoRouter ($0.42 against $0.41).
- For MiniMax H3 at 480p Protoface is the cheapest pay-per-use price ($0.05, the same as Callirra's Pro plan at full use, without a subscription). At 768p it costs more than KovAPI ($0.18 against $0.125) and it has no 1080p.
- Krea's API balance is the most expensive published route for Seedance 2.0 and Wan 3.0 at every resolution, and for MiniMax H3 it sells only one tier at $0.65.
- Krea's workspace plan units cannot be compared: two derived figures exist, both ranges that depend on the plan and on using it fully. The low end for Seedance 2.5 at 720p ($0.56, on the largest yearly Max plan during a promotion that ends 2026-11-24) would be under VideoRouter's $0.70; the high end is three times it.

Not verified here: whether Protoface charges less without audio, its supported durations per model, and any charged amount.
## Addendum, 15:00: Krea workspace units, quoted live

The user signed in to Krea. Free preflight quotes from the signed-in workspace (nothing queued or charged; `is_estimated: false`), same clip:

| Model | 480p | 720p | 1080p |
|---|---|---|---|
| Wan 3.0 | 277.78 units | 555.56 units | 1,111.11 units |
| Seedance 2.0 | 248.81 units | 560 units | 1,386 units |
| Seedance 2.5 | 380.33 units | 856 units | 2,106 units |
| MiniMax H3 | one tier only: 481.48 units | | |

These replace the derived figures above (856 lies inside the derived 851 to 870; 481.48 inside 476 to 482). In dollars it depends on what the plan costs per 1,000 units: Krea's page listed $1.65 (Max 100,000 monthly) and $0.66 (the same plan yearly, during the promotion ending 2026-11-24). At those two rates, 720p: Wan 3.0 $0.92 / $0.37; Seedance 2.0 $0.92 / $0.37; Seedance 2.5 $1.41 / $0.56; MiniMax H3 $0.79 / $0.32. Which rate applies to the user's plan was not checked.
## Addendum, 15:22: the user's plan, "Max 4"

Read by the lead from the data embedded in `https://www.krea.ai/pricing` on 2026-11-22: plan `creator_max_4`, name "Max 4", 100,000 compute units a month; monthly price 165 (reference price 220, "25% off"); yearly 66 a month (70% off, the promotion ending 2026-11-24), with model discounts on yearly that include "Seedance 2.5" 75% off. Which billing the user is on is not known.

Two paid Seedance 2.5 clips (5 s, 720p) each settled at 830.32 units against a quote of 856 (see `docs/work/0005-video-credentials/ledger.md`). At full use of the plan that is $1.37 a clip on monthly billing (830.32 x 165 / 100,000) and $0.55 on the yearly promotion price, against $0.70 on VideoRouter and $0.79 on KovAPI for the same clip. The quote of 856 units is the figure the public counts imply without a model discount, so the 75% Seedance 2.5 discount was not applied to these jobs.
## Addendum, 15:38: Flux 3 video, and Krea in dollars on the user's plan

The user's plan: PLAN-REMOVED. Asked: "how Flux 3 stacks against everything".

Flux 3 video, 5 s, 16:9, text only. It is offered at 720p and 1080p only (no 480p) on every route checked.

| Route | 720p | 1080p | Source, read by the lead 2026-11-22 |
|---|---|---|---|
| VideoRouter (`black-forest-labs/flux-3`; five hosts at the same rate, fee included) | $0.87 | $1.49 | `pricing-index.json`: $0.17 and $0.29 per second |
| Protoface (`black-forest-labs-flux-3`) | $0.85 | $1.45 | model page: $0.17 and $0.29 per second, minimum 5 s |
| Krea workspace (`black-forest-labs/flux-3-video`; `flux-3-max` quotes the same) | 629.63 units, $0.42 | 1,074.07 units, $0.71 | free preflight in the signed-in workspace, `is_estimated: false` |
| KovAPI | not offered | not offered | `kovapi.com/llms.txt` has no Flux entry |
| Callirra | not offered | not offered | no Flux row on `callirra.com/credit-costs` |

Krea quotes for all models at $0.00066 a unit, 480p / 720p / 1080p: Wan 3.0 $0.18 / $0.37 / $0.73; Seedance 2.0 $0.16 / $0.37 / $0.91; Seedance 2.5 $0.25 / $0.56 / $1.39; MiniMax H3 $0.32 (one tier); Flux 3 none / $0.42 / $0.71. These are quotes; the two Seedance 2.5 jobs settled 3% below the quote, and no Flux 3 job was run.

Price only. No comparison of picture quality was made.