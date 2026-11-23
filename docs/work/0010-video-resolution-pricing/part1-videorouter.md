# Part 1 — VideoRouter (videorouter.sh): price per resolution

Checked 2026-11-22. Public pages only, no sign-in, no key, nothing spent. `GET /api/v1/models` answered 401 and was not pursued.

## How to read the tables

- **Unit:** USD per second of output video, for every host of all four models. No per-clip, per-token or megapixel price is published for them.
- **Rates** are list prices before the fee, from [pricing-index.json](https://videorouter.sh/pricing-index.json) (generated 2026-11-22). Model and host pages show the same numbers rounded to 4 decimals and carry no date.
- **Cells:** `rate × 5 s` → `× 1.025`, 6 decimals. "not published" means the page shows "—". Bold marks the cheapest in a column.
- **2.5% charge: confirmed** on current pages: every host page ("+ VideoRouter platform fee: 2.5% of provider cost"), every model page, [/pricing](https://videorouter.sh/pricing), [/docs/pricing-billing](https://videorouter.sh/docs/pricing-billing) ("provider list price × 1.025"), and `platform_fee_rate: 0.025` in the index.
- **Durations:** no page publishes supported durations per host. Seedance 2.5 has a model-level range of 4–30 s. The playground field on every host page is a generic input (min 1, max 15, default 5).

## Seedance 2.5 — `bytedance/seedance-2.5` (14 routed hosts)

Source: [model page](https://videorouter.sh/video/bytedance/seedance-2.5). Durations: 4–30 s per the [Seedance 2.5 doc](https://videorouter.sh/docs/video-generation/seedance2.5); per host not published.

| Host (slug) | $/s 480p / 720p / 1080p | 480p, 5 s | 720p, 5 s | 1080p, 5 s | Durations | Source | Date on page |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SoCheap-Overseas (`socheap-overseas`) — app | — / 0.137 / — | not published | 0.685 → **0.702125** | not published | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/socheap-overseas) | none |
| BotSmart (`botsmart`) | 0.0799 / 0.1794 / 0.4435 | 0.3995 → **0.409488** | 0.897 → 0.919425 | 2.2175 → **2.272938** | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/botsmart) | none |
| OpenSand (`opensand`) | 0.085977 / 0.184896 / 0.454896 | 0.429885 → 0.440632 | 0.92448 → 0.947592 | 2.27448 → 2.331342 | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/opensand) | none |
| SoCheap-Official (`socheap-official`) | 0.0862 / 0.1934 / 0.4783 | 0.431 → 0.441775 | 0.967 → 0.991175 | 2.3915 → 2.451288 | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/socheap-official) | none |
| MachGen (`machgen`) | 0.08738 / 0.19645 / 0.48333 | 0.4369 → 0.447823 | 0.98225 → 1.006806 | 2.41665 → 2.477066 | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/machgen) | none |
| TOAPIS (`toapis`) | 0.10044 / 0.2175 / 0.5391 | 0.5022 → 0.514755 | 1.0875 → 1.114688 | 2.6955 → 2.762888 | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/toapis) | none |
| OpenRouter (`openrouter`) | 0.10280025 / 0.23112 / 0.52002 | 0.51400125 → 0.526851 | 1.1556 → 1.184490 | 2.6001 → 2.665103 | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/openrouter) | none |
| Replicate (`replicate`) | 0.1028 / 0.2312 / — | 0.514 → 0.526850 | 1.156 → 1.184900 | not published | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/replicate) | none |
| SoCheap-No-IP-Restriction (`socheap-no-ip-restriction`) | 0.1141 / 0.2564 / 0.6345 | 0.5705 → 0.584763 | 1.282 → 1.314050 | 3.1725 → 3.251813 | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/socheap-no-ip-restriction) | none |
| Atlas Cloud (`atlas-cloud`) | 0.13971204 / 0.300456 / 0.59136456 | 0.6985602 → 0.716024 | 1.50228 → 1.539837 | 2.9568228 → 3.030743 | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/atlas-cloud) | none |
| SandBase (`sandbase`) | 0.144 / 0.288 / 0.72 | 0.72 → 0.738000 | 1.44 → 1.476000 | 3.6 → 3.690000 | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/sandbase) | none |
| WaveSpeedAI (`wavespeedai`) | 0.162 / 0.324 / 0.81 | 0.81 → 0.830250 | 1.62 → 1.660500 | 4.05 → 4.151250 | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/wavespeedai) | none |
| Fal (`fal`) | 0.2205 / 0.473 / 1.164 | 1.1025 → 1.130063 | 2.365 → 2.424125 | 5.82 → 5.965500 | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/fal) | none |
| Fal-US (`fal-us`) | 0.2205 / 0.473 / — | 1.1025 → 1.130063 | 2.365 → 2.424125 | not published | 4–30 s (model level) | [host page](https://videorouter.sh/video/bytedance/seedance-2.5/fal-us) | none |

## Seedance 2.0 — `bytedance/seedance-2.0` (13 routed hosts)

Source: [model page](https://videorouter.sh/video/bytedance/seedance-2.0). Durations: not published.

| Host (slug) | $/s 480p / 720p / 1080p | 480p, 5 s | 720p, 5 s | 1080p, 5 s | Durations | Source | Date on page |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SoCheap-Overseas (`socheap-overseas`) — app | — / 0.0896 / — | not published | 0.448 → **0.459200** | not published | not published | [host page](https://videorouter.sh/video/bytedance/seedance-2.0/socheap-overseas) | none |
| BotSmart (`botsmart`) | 0.0549 / 0.1181 / 0.2968 | 0.2745 → **0.281363** | 0.5905 → 0.605263 | 1.484 → **1.521100** | not published | [host page](https://videorouter.sh/video/bytedance/seedance-2.0/botsmart) | none |
| OpenSand (`opensand`) | 0.056246 / 0.12096 / 0.299376 | 0.28123 → 0.288261 | 0.6048 → 0.619920 | 1.49688 → 1.534302 | not published | [host page](https://videorouter.sh/video/bytedance/seedance-2.0/opensand) | none |
| SoCheap-Official (`socheap-official`) | 0.0592 / 0.1274 / 0.3201 | 0.296 → 0.303400 | 0.637 → 0.652925 | 1.6005 → 1.640513 | not published | [host page](https://videorouter.sh/video/bytedance/seedance-2.0/socheap-official) | none |
| MachGen (`machgen`) | 0.05976 / 0.12852 / 0.31809 | 0.2988 → 0.306270 | 0.6426 → 0.658665 | 1.59045 → 1.630211 | not published | [host page](https://videorouter.sh/video/bytedance/seedance-2.0/machgen) | none |
| SoCheap-No-IP-Restriction (`socheap-no-ip-restriction`) | 0.0653 / 0.1472 / 0.351 | 0.3265 → 0.334663 | 0.736 → 0.754400 | 1.755 → 1.798875 | not published | [host page](https://videorouter.sh/video/bytedance/seedance-2.0/socheap-no-ip-restriction) | none |
| TOAPIS (`toapis`) | 0.066 / 0.14194 / 0.35426 | 0.33 → 0.338250 | 0.7097 → 0.727443 | 1.7713 → 1.815583 | not published | [host page](https://videorouter.sh/video/bytedance/seedance-2.0/toapis) | none |
| OpenRouter (`openrouter`) | 0.067252 / 0.151199 / 0.37422 | 0.33626 → 0.344667 | 0.755995 → 0.774895 | 1.8711 → 1.917878 | not published | [host page](https://videorouter.sh/video/bytedance/seedance-2.0/openrouter) | none |
| Replicate (`replicate`) | 0.08 / 0.18 / 0.45 | 0.4 → 0.410000 | 0.9 → 0.922500 | 2.25 → 2.306250 | not published | [host page](https://videorouter.sh/video/bytedance/seedance-2.0/replicate) | none |
| Atlas Cloud (`atlas-cloud`) | 0.08999424 / 0.193536 / 0.435456 | 0.4499712 → 0.461220 | 0.96768 → 0.991872 | 2.17728 → 2.231712 | not published | [host page](https://videorouter.sh/video/bytedance/seedance-2.0/atlas-cloud) | none |
| SandBase (`sandbase`) | 0.096 / 0.192 / 0.48 | 0.48 → 0.492000 | 0.96 → 0.984000 | 2.4 → 2.460000 | not published | [host page](https://videorouter.sh/video/bytedance/seedance-2.0/sandbase) | none |
| WaveSpeedAI (`wavespeedai`) | 0.12 / 0.24 / 0.6 | 0.6 → 0.615000 | 1.2 → 1.230000 | 3 → 3.075000 | not published | [host page](https://videorouter.sh/video/bytedance/seedance-2.0/wavespeedai) | none |
| Fal (`fal`) | 0.1345 / 0.3034 / 0.682 | 0.6725 → 0.689313 | 1.517 → 1.554925 | 3.41 → 3.495250 | not published | [host page](https://videorouter.sh/video/bytedance/seedance-2.0/fal) | none |

## Wan 3.0 — `alibaba/wan-3.0` (13 routed hosts)

Source: [model page](https://videorouter.sh/video/alibaba/wan-3.0). Durations: not published.

| Host (slug) | $/s 480p / 720p / 1080p | 480p, 5 s | 720p, 5 s | 1080p, 5 s | Durations | Source | Date on page |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BotSmart (`botsmart`) — app | 0.0221 / 0.0441 / 0.0882 | 0.1105 → **0.113263** | 0.2205 → **0.226013** | 0.441 → **0.452025** | not published | [host page](https://videorouter.sh/video/alibaba/wan-3.0/botsmart) | none |
| Replicate (`replicate`) — app | 0.025 / 0.05 / 0.1 | 0.125 → 0.128125 | 0.25 → 0.256250 | 0.5 → 0.512500 | not published | [host page](https://videorouter.sh/video/alibaba/wan-3.0/replicate) | none |
| SandBase (`sandbase`) | 0.03 / 0.06 / 0.12 | 0.15 → 0.153750 | 0.3 → 0.307500 | 0.6 → 0.615000 | not published | [host page](https://videorouter.sh/video/alibaba/wan-3.0/sandbase) | none |
| TOAPIS (`toapis`) | 0.03 / 0.06 / 0.12 | 0.15 → 0.153750 | 0.3 → 0.307500 | 0.6 → 0.615000 | not published | [host page](https://videorouter.sh/video/alibaba/wan-3.0/toapis) | none |
| Pika (`pika`) | 0.0325 / 0.065 / 0.13 | 0.1625 → 0.166563 | 0.325 → 0.333125 | 0.65 → 0.666250 | not published | [host page](https://videorouter.sh/video/alibaba/wan-3.0/pika) | none |
| Atlas Cloud (`atlas-cloud`) | 0.04 / 0.08 / 0.16 | 0.2 → 0.205000 | 0.4 → 0.410000 | 0.8 → 0.820000 | not published | [host page](https://videorouter.sh/video/alibaba/wan-3.0/atlas-cloud) | none |
| MuleRouter (`mulerouter`) | 0.04 / 0.08 / 0.16 | 0.2 → 0.205000 | 0.4 → 0.410000 | 0.8 → 0.820000 | not published | [host page](https://videorouter.sh/video/alibaba/wan-3.0/mulerouter) | none |
| MachGen (`machgen`) | 0.04165 / 0.0816 / 0.16235 | 0.20825 → 0.213456 | 0.408 → 0.418200 | 0.81175 → 0.832044 | not published | [host page](https://videorouter.sh/video/alibaba/wan-3.0/machgen) | none |
| Alibaba (`alibaba`) | 0.05 / 0.1 / 0.2 | 0.25 → 0.256250 | 0.5 → 0.512500 | 1 → 1.025000 | not published | [host page](https://videorouter.sh/video/alibaba/wan-3.0/alibaba) | none |
| Fal (`fal`) | 0.05 / 0.1 / 0.2 | 0.25 → 0.256250 | 0.5 → 0.512500 | 1 → 1.025000 | not published | [host page](https://videorouter.sh/video/alibaba/wan-3.0/fal) | none |
| WaveSpeedAI (`wavespeedai`) | 0.05 / 0.1 / 0.2 | 0.25 → 0.256250 | 0.5 → 0.512500 | 1 → 1.025000 | not published | [host page](https://videorouter.sh/video/alibaba/wan-3.0/wavespeedai) | none |
| OpenRouter (`openrouter`) | 0.10625 / 0.2125 / 0.425 | 0.53125 → 0.544531 | 1.0625 → 1.089063 | 2.125 → 2.178125 | not published | [host page](https://videorouter.sh/video/alibaba/wan-3.0/openrouter) | none |
| DeepInfra (`deepinfra`) | flat 0.2 (`"*"` in index; model page lists it under 1080p only) | not published | not published | 1 → 1.025000 | not published | [host page](https://videorouter.sh/video/alibaba/wan-3.0/deepinfra) | none |

## MiniMax H3 — `minimax/h3` (listed; 13 routed hosts; not used by the app)

Source: [model page](https://videorouter.sh/video/minimax/h3). No host lists 720p; 768p is the base tier. Durations: not published.

| Host (slug) | $/s 480p / 768p / 1080p | 480p, 5 s | 768p, 5 s | 1080p, 5 s | Durations | Source | Date on page |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kie.ai (`kie-ai`) | — / 0.04 / — | not published | 0.2 → **0.205000** | not published | not published | [host page](https://videorouter.sh/video/minimax/h3/kie-ai) | none |
| SandBase (`sandbase`) | — / 0.048 / — | not published | 0.24 → 0.246000 | not published | not published | [host page](https://videorouter.sh/video/minimax/h3/sandbase) | none |
| MachGen (`machgen`) | 0.044 / 0.05 / — | 0.22 → 0.225500 | 0.25 → 0.256250 | not published | not published | [host page](https://videorouter.sh/video/minimax/h3/machgen) | none |
| Fal (`fal`) | 0.05 / 0.06 / — | 0.25 → 0.256250 | 0.3 → 0.307500 | not published | not published | [host page](https://videorouter.sh/video/minimax/h3/fal) | none |
| Novita (`novita`) | — / 0.069 / — | not published | 0.345 → 0.353625 | not published | not published | [host page](https://videorouter.sh/video/minimax/h3/novita) | none |
| OpenSand (`opensand`) | — / 0.072 / — | not published | 0.36 → 0.369000 | not published | not published | [host page](https://videorouter.sh/video/minimax/h3/opensand) | none |
| Atlas Cloud (`atlas-cloud`) | 0.038 / 0.08 / 0.08 | 0.19 → **0.194750** | 0.4 → 0.410000 | 0.4 → **0.410000** | not published | [host page](https://videorouter.sh/video/minimax/h3/atlas-cloud) | none |
| WaveSpeedAI (`wavespeed`) | 0.04 / 0.08 / 0.16 | 0.2 → 0.205000 | 0.4 → 0.410000 | 0.8 → 0.820000 | not published | [host page](https://videorouter.sh/video/minimax/h3/wavespeed) | none |
| MiniMax (`minimax`) | — / 0.08 / — | not published | 0.4 → 0.410000 | not published | not published | [host page](https://videorouter.sh/video/minimax/h3/minimax) | none |
| Pika (`pika`) | — / 0.08 / — | not published | 0.4 → 0.410000 | not published | not published | [host page](https://videorouter.sh/video/minimax/h3/pika) | none |
| Replicate (`replicate`) | — / 0.08 / — | not published | 0.4 → 0.410000 | not published | not published | [host page](https://videorouter.sh/video/minimax/h3/replicate) | none |
| TOAPIS (`toapis`) | — / 0.08 / — | not published | 0.4 → 0.410000 | not published | not published | [host page](https://videorouter.sh/video/minimax/h3/toapis) | none |
| WaveSpeedAI-resell (`wavespeed-resell`) | — / 0.1 / — | not published | 0.5 → 0.512500 | not published | not published | [host page](https://videorouter.sh/video/minimax/h3/wavespeed-resell) | none |

Most H3 hosts offer only 768p and 2K. 2K at kie.ai: 0.065 × 5 = 0.325 → 0.333125. The model page also shows a separate "MiniMax — Temporarily unavailable" row.

## What else changes the price (question 1)

| Factor | Effect | Where stated |
| --- | --- | --- |
| Audio | Wan 3.0 `generate_audio`: "The price is the same either way". Seedance and H3: no audio price line shown | [video docs](https://videorouter.sh/docs/video-generation), host pages |
| Fast / mini / flash / prime / max | Separate model ids with their own prices (`seedance-2.0-fast`, `seedance-2.0-mini`, `seedance-2.5-flash`, `wan-3.0-prime`, `minimax/h3-max`, `h3-max-turbo`); not request options | [price digest](https://videorouter.sh/video-generation-api/pricing) |
| `-sr`, `-esr`, 60 fps variants | Atlas Cloud only, at their own rates | model pages |
| Start image, reference images | Same rate. H3: kie.ai +$0.02 and Atlas Cloud +$0.04 per reference image beyond the first 5 | host pages |
| Reference video | Seedance 2.5: lower $/s but reference + output seconds billed on most hosts; SoCheap-Overseas and Replicate bill output only. Seedance 2.0 SoCheap-Overseas, Wan BotSmart, H3: same rate × (reference + output seconds) | model and host pages |
| Seedance 2.5 `draft`, `auto_upscale` | Draft bills as a 480p render; upscale is "priced at that upscaled tier" | [Seedance 2.5 doc](https://videorouter.sh/docs/video-generation/seedance2.5), [API reference](https://videorouter.sh/docs/api-reference-video) |

## Question 2 — does 720p reproduce the catalog?

Yes, all four, exactly.

| Variant | Arithmetic | Catalog |
| --- | --- | --- |
| Seedance 2.5 SoCheap-Overseas | 0.137 × 5 = 0.685; × 1.025 = 0.702125 | 0.702125 |
| Seedance 2.0 SoCheap-Overseas | 0.0896 × 5 = 0.448; × 1.025 = 0.4592 | 0.459200 |
| Wan 3.0 BotSmart | 0.0441 × 5 = 0.2205; × 1.025 = 0.2260125 | 0.226013 (rounded up) |
| Wan 3.0 Replicate | 0.05 × 5 = 0.25; × 1.025 = 0.25625 | 0.256250 |

The catalog assumes the pinned host serves the job and bills output seconds only. Prices move: a VideoRouter article checked on 2026-10-19 quoted SoCheap-Overseas Seedance 2.5 720p at $0.1419/s; it is $0.137/s now.

## Question 3 — cheapest host per resolution (5 s, with fee)

| Model | 480p | 720p / 768p | 1080p | Changes? |
| --- | --- | --- | --- | --- |
| Seedance 2.5 | BotSmart 0.409488 | SoCheap-Overseas 0.702125 (next: BotSmart 0.919425) | BotSmart 2.272938 | Yes |
| Seedance 2.0 | BotSmart 0.281363 | SoCheap-Overseas 0.459200 (next: BotSmart 0.605263) | BotSmart 1.521100 | Yes |
| Wan 3.0 | BotSmart 0.113263 | BotSmart 0.226013 | BotSmart 0.452025 | No |
| MiniMax H3 | Atlas Cloud 0.194750 | kie.ai 0.205000 | Atlas Cloud 0.410000 | Yes |

SoCheap-Overseas lists 720p only, so both Seedance models need a second host for 480p and 1080p.

## Question 4 — selecting resolution

**Parameter:** `resolution` (a tier string) with `aspect_ratio`; explicit `height`/`width` override both. Host pages label their price table "Resolution (via `size`)", but the API reference and the pages' own playground code send `resolution`.

| Model | Accepted `resolution` values (per-host lists embedded in the model pages) |
| --- | --- |
| Seedance 2.5 | `480p`, `720p`, `1080p`; `4k` on BotSmart, TOAPIS, OpenRouter, Atlas Cloud, WaveSpeedAI. Replicate and Fal-US: `480p`, `720p`. SoCheap-Overseas: `720p` only |
| Seedance 2.0 | `480p`, `720p`, `1080p`; `4k` or `2160p` on nine hosts. SoCheap-Overseas: `720p` only |
| Wan 3.0 | `480p`, `720p`, `1080p` on every host; Atlas Cloud adds `1440p`, `4k`. DeepInfra: empty list |
| MiniMax H3 | Spelling varies by host: `768P`/`2K` (MiniMax, kie.ai, SandBase, Novita, Replicate, Pika); `768p`/`2k` (OpenSand, WaveSpeedAI-resell); `768p`/`2K` (TOAPIS); `480P`/`768P`/`2K`/`4K` (Fal); `480p`/`768p`/`1440p` (MachGen); `480p`/`540p`/`768p`/`1080p` (WaveSpeedAI); `480p`/`768p`/`1080p`/`2k`/`4k` (Atlas Cloud) |

**Unsupported value:** "An unsupported combination is silently ignored (model default used), never a 400." VideoRouter's own H3 guide adds: "you can end up billed for a different resolution than you requested without an error telling you so."

**Defaults differ by host** (playground defaults in the model pages): Wan 3.0 BotSmart and Replicate default to `1080p`; H3 kie.ai, SandBase and TOAPIS to `2K`; Seedance on MachGen and WaveSpeedAI to `480p`. If the API default is the same, a dropped `resolution` on Wan BotSmart costs 0.452025 instead of 0.226013.

## Question 5 — published versus charged

- **Soft pin:** `model/<host>` is a preference. If that host rejects the job, VideoRouter walks the other hosts cheapest-first; for Seedance 2.5 at 720p the next host costs 31% more. A hard pin needs `provider: {"only": [...], "allow_fallbacks": false}`; `provider.max_price` returns 422 instead of overpaying.
- **Final price is the host's:** "the final charge is the host's actual cost". The Terms say a charge can become final only after the run. The finished job reports `cost_usd`.
- **Duration:** default 4 s, "Snapped to the nearest value the model actually supports; some models bill a fixed length regardless of what's requested." Billed once, in full, at creation.
- **Failed jobs:** refunded (`cost_usd` 0). A timeout hedge (`failover.on_timeout_sec`) bills both attempts.
- **Minimum:** none per request. Top-ups have a $10 minimum plus Stripe's fee (2.9% + $0.30 US cards, 4.4% + $0.30 others), outside the per-clip figure.
- **Promotions, end dates, regions:** none published. "% off" labels compare against Fal. SoCheap-Overseas's page states no restriction; VideoRouter's articles call it the overseas "low" row and say to check "availability and guarantees". A sibling host is named SoCheap-No-IP-Restriction.
- **Stale static pages:** [/pricing](https://videorouter.sh/pricing) still shows Wan 3.0's lowest rate as SandBase $0.060/s, and the price digest shows "Atlas Cloud — $0.064" (a 720p-esr variant). Use the model pages or the index JSON.

## Evidence

| Primary URL | Fact or quoted figure | Date / version | Caveats |
| --- | --- | --- | --- |
| https://videorouter.sh/video/bytedance/seedance-2.5/socheap-overseas | "720p \| $0.137 / second"; with a reference video "the price is unchanged"; fee "2.5% of provider cost" | no date on page | 720p is the only tier |
| https://videorouter.sh/video/bytedance/seedance-2.0/socheap-overseas | "720p \| $0.0896 / second" | no date on page | reference video seconds are billed |
| https://videorouter.sh/video/alibaba/wan-3.0/botsmart | 480p "$0.0221 / second", 720p "$0.0441 / second", 1080p "$0.0882 / second" | no date on page | — |
| https://videorouter.sh/video/alibaba/wan-3.0/replicate | 480p "$0.025 / second", 720p "$0.05 / second", 1080p "$0.1 / second" | no date on page | — |
| https://videorouter.sh/video/bytedance/seedance-2.5 , https://videorouter.sh/video/bytedance/seedance-2.0 , https://videorouter.sh/video/alibaba/wan-3.0 , https://videorouter.sh/video/minimax/h3 | full host tables; per-host resolution lists and defaults in the page script | no date on page | rates rounded to 4 decimals |
| https://videorouter.sh/video/minimax/h3/kie-ai , https://videorouter.sh/video/minimax/h3/atlas-cloud , https://videorouter.sh/video/minimax/h3/wavespeed | kie.ai 768P $0.04, 2K $0.065; Atlas Cloud 480p $0.038, 768p $0.08, 1080p $0.08; WaveSpeedAI 480p $0.04, 768p $0.08, 1080p $0.16 | no date on page | Atlas Cloud 1080p equals its 768p rate |
| https://videorouter.sh/pricing-index.json | unrounded rates; `"unit": "second"`; `"platform_fee_rate": 0.025` | generated 2026-11-22 | list prices before fee |
| https://videorouter.sh/health | `"synced_at": "2026-11-22T08:47:45…"`, `"stale": false`, `"price_deltas_flagged": 0` | 2026-11-22 | — |
| https://videorouter.sh/docs/pricing-billing | "provider list price × 1.025 — a flat 2.5% platform fee"; "A minimum deposit of $10 applies" | no date on page | — |
| https://videorouter.sh/docs/api-reference-video | `resolution`, `duration_secs` wording quoted above; "Billed once, in full, at creation time" | no date on page | — |
| https://videorouter.sh/docs/provider-selection | host suffix "tries Fal first, still falls back to the rest of the pool"; `max_price` 422; "Both attempts get billed" | no date on page | — |
| https://videorouter.sh/docs/video-generation | Wan audio "The price is the same either way"; `cost_usd` "0 for a failed, refunded job" | no date on page | — |
| https://videorouter.sh/docs/video-generation/seedance2.5 | "Duration is duration_secs from 4 to 30 seconds; resolution is 480p, 720p or 1080p"; "failed jobs are not charged" | no date on page | model level, not per host |
| https://videorouter.sh/terms | charges final "when the underlying provider reports its actual cost" | effective 2026-09-17 | — |
| https://videorouter.sh/blogs/seedance-wan-minimax-h3-price-comparison-higgsfield-comfy-openrouter-videorouter | "SoCheap's overseas "low" row at $0.1419 per second" | checked 2026-10-19 | vendor article, not the live catalog |
| https://videorouter.sh/blogs/how-to-call-minimax-h3-api | "an unsupported tier is silently ignored rather than rejected" | no date on page | vendor article |

## Not verified

- Supported durations per host, and whether each host accepts 5 s without snapping.
- What `480p` or `1080p` does with the `socheap-overseas` suffix: rendered at 720p, or moved to another host.
- Whether the API's "model default" resolution equals the playground default.
- Whether H3 resolution values are case-sensitive.
- What Atlas Cloud delivers for H3 plain `1080p` at the 768p rate, and what `-sr` / `-esr` mean (the index says only "upscaled / frame-rate variants").
- What DeepInfra renders for Wan 3.0 below 1080p; the index gives one flat rate.
- Whether per-second figures for token-billed Seedance hosts assume 16:9.
- Any audio surcharge for Seedance or H3: none is shown, none is ruled out.
- Regional or IP restrictions, availability terms and any price end date for SoCheap-Overseas.
- Charged amounts: no job was run, so every figure is a published price, not an invoice.
