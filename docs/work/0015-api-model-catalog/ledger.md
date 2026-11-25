# API model catalog — scope and verification

The macOS Models page should answer two different questions: “what chat models can I browse?” and “what can my gateway route now?” Listing a model must not enable it, read an extra credential, change a lane, or incur an inference charge.

Acceptance checks:
- Include every built-in API provider, including region-specific entries, before a key is set. Include models explicitly configured on custom endpoints.
- Keep route IDs namespaced: the same upstream model sold by two services is two different routes. A public listing is not evidence of access in a direct provider account or region.
- Discover additional chat models via supported metadata sources on explicit refresh. Preserve the built-in list when metadata is unavailable. Do not conflate text chat with embedding, image generation, audio or video listings.
- Keep subscription offer controls separate. No automatic publication to Harness, paid probes, Windows UI changes, deployment or app restart.

Release gates: Node syntax checks passed on 115 files; full local suite 976 tests (967 passed, 9 skipped, 0 failed). Swift release build succeeded and KitChecks passed 36/36. Independent static review found no actionable issues. Public refresh currently covers OpenRouter only. No live inference or paid calls used for verification. Release and app restart were authorized separately after implementation.
