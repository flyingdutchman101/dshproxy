# Part 2: resolution pricing on KovAPI, Callirra and Krea

Read-only research, public pages only, fetched 2026-11-22 about 12:40–12:50 UTC. No sign-in, no key, no quote or generation call.
Reference clip: 5 s, 16:9, text-to-video, no references, no audio add-on. All prices in US dollars.

Headline findings:

- KovAPI and Callirra publish all three resolutions, and both reproduce the catalog figures exactly.
- Krea does not publish compute units per clip. Its pricing page publishes only "how many videos per plan" counts, at settings that match the reference clip for two of the four models.
- Krea's `video/minimax/hailuo-3` has no resolution selector: confirmed. It is a fixed 2K-tier endpoint.
- If the app omits `resolution` on KovAPI `minimax-h3`, it gets 1080P ($0.18), not 768P ($0.125).

## A. KovAPI (pay per use)

| Model | Unit price as published | 480P clip | 720P / 768P clip | 1080P clip | Durations | Source | Date on page |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `seedance-2.5` | $0.10 / $0.158 / $0.38 per s | 5 × 0.10 = **$0.50** | 5 × 0.158 = **$0.79** | 5 × 0.38 = **$1.90** | 4–30 s, whole seconds | https://docs.kovapi.com/seedance-2.5/md | no date on page |
| `seedance-2.0` | $0.07 / $0.105 / $0.25 per s (4K $0.76) | 5 × 0.07 = **$0.35** | 5 × 0.105 = **$0.525** | 5 × 0.25 = **$1.25** | 5–15 s | https://docs.kovapi.com/seedance-2.0/md | price cut announced 2026-11-21 |
| `minimax-h3` | $0.015 / $0.025 / $0.036 per s | 5 × 0.015 = **$0.075** | 768P: 5 × 0.025 = **$0.125** | 5 × 0.036 = **$0.18** | 4–15 s | https://docs.kovapi.com/minimax-h3 | tiers announced 2026-11-11 |
| `wan3.0-video` | $0.04 / $0.065 / $0.13 per s | 5 × 0.04 = **$0.20** | 5 × 0.065 = **$0.325** | 5 × 0.13 = **$0.65** | 4–30 s | https://docs.kovapi.com/wan3.0-video/md | no date on page |

Tiers are separate model IDs with their own prices (`seedance-2.5-flash`, `seedance-2.0-fast`, `seedance-2.0-mini`, `minimax-h3-lite`, `wan3.0-video-prime`). Sound is always on and never priced separately. A reference video changes the price: its seconds are billed too, and Seedance 2.5 switches to a separate rate ($0.06 / $0.11 / $0.27 per s). Reference images and audio are free.

## B. Callirra (plan credits, MiniMax H3 only)

| Model | Unit price as published | 480P clip | 768P clip | 1080P clip | Durations | Source | Date on page |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MiniMax H3 · Standard | 1 / 2 / 3 credits per s | **5 credits** | **10 credits** | **15 credits** | up to 15 s at 480P and 768P, up to 10 s at 1080P; minimum not published | https://callirra.com/credit-costs and https://callirra.com/minimax-h3 | no date on page |

Dollar range, monthly plans at full use (price ÷ credits × clip credits):

| Plan | $ per credit | 480P | 768P | 1080P |
| --- | --- | --- | --- | --- |
| Max-L, $149.00 / 18,000 (cheapest) | 0.008278 | $0.0414 | $0.0828 | $0.1242 |
| Max, $69.90 / 8,000 | 0.008738 | $0.0437 | $0.0874 | $0.1311 |
| Pro, $29.90 / 3,000 | 0.009967 | $0.0498 | $0.0997 | $0.1495 |
| Starter, $9.90 / 800 (most expensive) | 0.012375 | $0.0619 | $0.1238 | $0.1856 |

Other tiers exist (960P 3 credits/s, 1440P scene presets 4, 2K 10). Callirra's own rate card values a credit at $0.01, giving $0.05 / $0.10 / $0.15.

## C. Krea

### C1. Workspace compute units (the route the app uses)

| Model path | Unit as published | 480p | 720p / 768p | 1080p | Durations | Source | Date |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `video/bytedance/seedance-2-5` | videos per plan: "5s, 720p, no video reference": ~23 (Pro 20,000) / ~46 (Max 40,000); Basic blank | not published | units not published; counts imply about 851–870 units (derived) | not published | 4–30 s | https://www.krea.ai/pricing | no date on page |
| `video/bytedance/seedance-2` | only "4s, 480p, video reference": ~163 / ~327; Basic blank | not published | not published | not published | 4–15 s | same | same |
| `video/minimax/hailuo-3` | "5s, no reference images": ~10 (Basic 5,000) / ~41 / ~83 | no selector | no selector; counts imply about 476–482 units (derived), one fixed tier | no selector | 5–15 s | same | same |
| `video/alibaba/wan-3.0` | only "2s, 480p": ~45 / ~180 / ~360 | not published for 5 s | not published | not published | 2–30 s | same | same |

Derivation: the page floors its counts (5,000 ÷ 9 → "555 images"), so "~46 from 40,000" means 40,000/47 < units ≤ 40,000/46. This is arithmetic on published counts, not a published unit price.

Price per 1,000 units, as embedded in the pricing page on 2026-11-22 (yearly shown per month):

| Plan | Monthly | Yearly |
| --- | --- | --- |
| Basic, 5,000 | $9 → $1.80 | $5.25 → $1.05 |
| Pro, 20,000 | $35 → $1.75 | $21 → $1.05 |
| Max, 40,000 / 60,000 / 80,000 / 100,000 | $70 / $105 / $135 / $165 → $1.75 / $1.75 / $1.69 / $1.65 | $28 / $42 / $54 / $66 → $0.70 / $0.70 / $0.675 / $0.66 |
| Business, 20,000 to 1,500,000 | $50 to $2,850 → $2.50 to $1.90 | $24 to $1,368 → $1.20 to $0.912 |
| Top-up packs, 2,000 to 100,000 (valid 90 days) | $4.99 / $12.00 / $19.99 / $44.99 / $89.99 / $176.99 → $2.50 to $1.77 | — |

Resulting range, assuming full use of the plan and no model discount:

| Clip | Cheapest (Max 100,000 yearly, $0.66) | Pro or Max monthly ($1.75) | Most expensive (Business monthly, $2.50) |
| --- | --- | --- | --- |
| Seedance 2.5, 720p (851–870 units) | $0.56–$0.57 | $1.49–$1.52 | $2.13–$2.17 |
| MiniMax H3, fixed tier (476–482 units) | $0.31–$0.32 | $0.83–$0.84 (Basic monthly $0.86–$0.87) | $1.19–$1.20 |
| Seedance 2.0, Wan 3.0, and every 480p or 1080p cell | not published | not published | not published |

### C2. Krea API balance (a different wallet, shown because the same pages publish it)

| Model path | Unit price as published | 480p | 720p | 1080p | Source |
| --- | --- | --- | --- | --- | --- |
| `seedance-2-5` | "Variable: the exact cost depends on the completed job and provider result" | not published | not published | not published | https://www.krea.ai/app/api/pricing |
| `seedance-2` | $0.0672 / $0.1512 / $0.3742 per s (no video reference) | $0.336 | $0.756 | $1.871 | https://www.krea.ai/docs/api-reference/video/seedance-20*.md |
| `hailuo-3` | $0.65 per 5 s request, 0–5 reference images | no selector | $0.65, fixed | no selector | https://www.krea.ai/docs/api-reference/video/minimax-h3.md |
| `wan-3.0` | $0.075 / $0.15 / $0.30 per s | $0.375 | $0.75 | $1.50 | https://www.krea.ai/docs/api-reference/video/wan-30.md |

## D. First-party list prices (reference only)

| Model | 480p | 720p / 768p | 1080p | Source |
| --- | --- | --- | --- | --- |
| Seedance 2.5 (BytePlus ModelArk) | $0.103/s → $0.514 | $0.231/s → $1.156 | $0.569/s → $2.843 | https://docs.byteplus.com/en/docs/ModelArk/1544106 (updated 2026-11-21) |
| Seedance 2.0 (BytePlus ModelArk) | $0.07/s → $0.35 | $0.15/s → $0.76 | $0.37/s → $1.87 | same |
| MiniMax-H3 (MiniMax) | not published for this model | 768P $0.08/s → $0.40 | not published (2K $0.13/s → $0.65) | https://platform.minimax.io/docs/pricing/overview (no date) |
| Wan 3.0 (Alibaba Model Studio, Singapore) | $0.05/s → $0.25 | $0.10/s → $0.50 | $0.20/s → $1.00 | https://www.alibabacloud.com/help/en/model-studio/model-pricing (updated 2026-11-21) |

Alibaba marks all three Wan 3.0 prices "30% off for a limited time" without an end date; applying it gives $0.175 / $0.35 / $0.70 (my arithmetic, the discounted figure is not printed).

## Evidence

| Primary URL | Fact or quoted figure | Date or version | Caveats |
| --- | --- | --- | --- |
| https://docs.kovapi.com/seedance-2.5/md | "480P 20 credits/s $0.10 · 720P 31.6 $0.158 · 1080P 76 $0.38"; "A 5-second clip $0.50 / $0.79 / $1.90"; "1 credit = $0.005" | no date | `duration` is "4 when omitted" |
| https://docs.kovapi.com/seedance-2.0/md | "480P $0.07 · 720P $0.105 · 1080P $0.25 · 4K $0.76"; 5-second clip "$0.35 / $0.525 / $1.25" | no date | 5–15 s |
| https://kovapi.com/announcements | "Seedance 2.0 price cut: 720P $0.15 → $0.105 … 1080P $0.30 → $0.25 … 480P $0.07, unchanged" | 2026-11-21 | "Price changes are announced at least one day ahead" |
| https://docs.kovapi.com/minimax-h3 | "480P / 768P / 1080P; 1080P when omitted"; "$0.015 / $0.025 / $0.036" | tiers announced 2026-11-11 | model page: "720P is read as 768P" |
| https://docs.kovapi.com/wan3.0-video/md | "480P $0.04 · 720P $0.065 · 1080P $0.13"; clip "$0.20 / $0.325 / $0.65" | no date | `duration` is "4 when omitted" |
| https://kovapi.com/pricing | Top-ups "$5 1,000 … $50 10,300 +3% … $200 42,000 +5% … $500 107,000 +7% … $1,250 275,000 +10%"; credits "never expire" | no date | plans $6.88 / 1,400 to $98.88 / 19,800 |
| https://kovapi.com/model/seedance-2.0 | "Success rate 43.3%" over 7 days; "refused at submit … never silently downgraded, never charged" | live figure | Seedance 2.5 shows 99.6%, Wan 3.0 100% |
| https://callirra.com/credit-costs | "MiniMax H3 · Standard 480P (5s) 5 credits · 768P (5s) 10 credits · 1080P (5s) 15 credits" | no date | "The final charge depends on actual usage" |
| https://callirra.com/pricing | Starter $9.90 / 800, Pro $29.90 / 3,000, Max $69.90 / 8,000, Max-L $149.00 / 18,000; "Quarterly Save 15%", "Yearly Save up to 20%" | no date | quarterly, yearly and pack prices are client-rendered: not read |
| https://callirra.com/guides/minimax-h3/h3-api-mcp-cli-contract | "`"1000"` is 10 credits, which is five seconds at 768P"; invalid combinations "rejected before job creation with HTTP 400" | 2026-11-01 | provider's own guide |
| https://www.krea.ai/pricing | Video generation counts and plan data quoted in C1; `deadline=1795507200000`, `phase="black-friday"` | fetched 2026-11-22 12:42 UTC | counts and plan prices sit in server-rendered text and embedded page data; units per clip do not appear anywhere |
| https://www.krea.ai/docs/api-reference/video/minimax-h3.md | Path `/generate/video/minimax/hailuo-3`; properties are prompt, images, references, `duration` 5–15; no `resolution`; `additionalProperties: false`; "Frontier 2K model" | OpenAPI v1 | — |
| https://www.krea.ai/docs/api-reference/video/seedance-25*.md | `resolution` enum 480p, 720p, 1080p, 4k, default 720p; no pricing table | OpenAPI v1 | `generate_audio` "rejected" after 2026-10-30 |
| https://www.krea.ai/docs/developers/mcp.md | "OAuth: compute units on the workspace … API token: your workspace's separate API balance"; `preflight` returns `compute_units` | no date | preflight needs sign-in: not used |
| https://www.krea.ai/docs/user-guide/help-and-support/compute-units.md | "Generations will also be less costly on higher tier plans"; packs "must be used within 90 days" | no date | — |
| https://www.krea.ai/blog/seedance-2-5-pricing-cost-per-video | serves the Seedance 2.5 model page (canonical `/models/seedance-2-5`); no per-video cost on it | fetched 2026-11-22 | — |

## Answers

**2. Price per unit.** Callirra: $0.0083 to $0.0124 per credit on monthly plans, so the 768P clip is $0.083 to $0.124 at full use; yearly is "up to 20%" lower but the amounts were not readable. Krea: $0.66 to $2.50 per 1,000 units, so the two derivable clips span $0.31–$1.20 (H3) and $0.56–$2.17 (Seedance 2.5 720p). Unused units make every figure higher. KovAPI is dollar-priced; bonus credits lower the effective cost by up to 9.1% ($1,250 buys 275,000 credits).

**3. Catalog check.** KovAPI: all four reproduce ($0.790, $0.525, $0.125, $0.325). Seedance 2.0 only since the 2026-11-21 cut. Callirra: reproduces (10 credits; $29.90 ÷ 3,000 × 10 = $0.099667). Krea: no catalog figure was given to me and no unit price is published.

**4. Selecting resolution.**
- KovAPI: `resolution`, upper-case with the P. Seedance 2.5 and Wan 3.0: 480P, 720P, 1080P. Seedance 2.0 adds 4K. MiniMax H3: 480P, 768P, 1080P. Default is 720P, except MiniMax H3 where it is 1080P. An invalid value returns HTTP 400 `invalid_request`, no job, no charge.
- Callirra: `resolution` (case-insensitive, for example `768P`), with `duration_seconds` and `aspect_ratio`. Unsupported combinations return HTTP 400 `invalid_request_error` before a job exists.
- Krea: `resolution`, lower-case. Seedance 2.5 and 2.0: 480p, 720p, 1080p, 4k. Wan 3.0: 480p, 720p, 1080p. Default 720p. `hailuo-3` has none. An out-of-enum value or an unknown key returns HTTP 422 "Validation failed". Resolution-selectable H3 variants exist under other paths (`minimax/h3-max-turbo`, `minimax/h3-max`: 480p, 768p, 1080p).

**5. Published versus charged.**
- KovAPI: the hold at submit equals the settle; failures and rejections are refunded in full; each resubmission is billed. Omitting `duration` gives 4 s on Seedance 2.5 and Wan 3.0. The playground lists whole credits (126 for 126.4); whether the API settles fractions is not documented.
- Callirra: no idempotency key, so a dropped connection can bill twice. Failed jobs are refunded. Plan credits expire monthly. Seedance needs a paid plan; H3 does not.
- Krea: failed and cancelled jobs are not billed. Units cost less on higher plans. The page shows a promotion ending 2026-11-24 08:00 UTC (yearly up to 70% off; Seedance 2.5 model price −60% on yearly Pro, −75% on yearly Max). Seedance 2.5 and 2.0 show no count for Basic, which suggests they are Pro and above. Wan 3.0 defaults to `aspect_ratio: adaptive`, so send 16:9 explicitly.

## Not verified

- Every Krea compute-unit figure. The 851–870 and 476–482 values are derived from rounded counts, and the mapping of the three count columns to Basic, Pro and Max 40,000 rests on the 1:4:8 ratio and the buttons under the table. Only an authenticated preflight would give real numbers.
- Krea units for Seedance 2.0 and Wan 3.0 at 5 s, and for any model at 480p or 1080p.
- Whether the Krea counts already include the promotional Seedance 2.5 discount, and Krea plan prices after 2026-11-24. The plan cards quote "~65 Seedance 2.5 videos" per 20,000 units at unstated settings, which does not match the 5 s 720p row.
- That `hailuo-3` output is 2K: the description says "Frontier 2K model" and $0.65 equals 5 × MiniMax's $0.13 2K rate, but no page states the output size.
- Callirra quarterly, yearly and credit-pack prices, and the minimum text-to-video duration.
- Which BytePlus token table is "with video input": I assigned them by arithmetic (108,000 tokens × $10.70 per million = $1.156). The per-clip figures in table D are printed on the page.
- Volcengine's page was fetched but not parsed; MiniMax publishes no 480P or 1080P price for the flagship H3.
