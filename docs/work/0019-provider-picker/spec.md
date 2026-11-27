# Provider picker parity in DSHProxy’s existing screens

A credential authorizes an account; it does not opt the user into any model or purchase. A selectable entry must correspond to an executable model, preset and billing route. Use Krea's model – preset – provider convention, preserving existing IDs. Unsupported inputs and unquotable paid routes should have a visible reason before enablement, not silently disappear afterward.

## Contract evidence

- The [Yotta Labs Gateway example](https://docs.yottalabs.ai/products/ai-gateway.md) documents `kling-v3-std-text`, `X-API-KEY`, a `parameters` object, and success code `10000` with `data.request_id`. Status uses a separate GET. For a 5 s no-audio fixture, the published gateway rate $0.0714/s gives a dated estimate of $0.357. Do not advertise a resolution the endpoint does not promise. Other modalities need individual contract and Harness-input verification.
- The current picker profile hardcodes text input and video API. Voice and asset models need a real result/input path: removing an eligibility filter or publishing catalog rows is insufficient.
- Foreplay Discovery search and saved boards already exist in the desktop/CLI. User selected both a dedicated Ad research – Foreplay picker entry and a separate opt-in switch that makes research tools available in any chat without switching models. Neither switch authorizes spending.

## Observable acceptance criteria

1. Enable, apply and inspect the DSH profile: each supported selection appears once with a stable provider-qualified ID. Existing Krea IDs do not change. Disable and reapply removes it; stale IDs cannot submit.
2. Every claimed modality routes from Harness to its provider with the documented inputs and yields a usable result of the promised type. Never send speech or asset requests to a text-to-video fallback.
3. Opening or selecting an entry does not purchase. One confirmation authorizes one exact paid media request. Refusal and ambiguous disconnect never cause a repeat purchase. Synthetic fixtures only; no customer credentials or paid tests.
4. Windows and macOS communicate unsupported presets before enablement. Foreplay desktop functionality remains intact.

No push, deployment, live spend, or credential changes are part of this proposal.
