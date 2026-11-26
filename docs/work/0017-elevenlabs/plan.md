# Implementation slices

1. Video catalog, quote, credentials, and transport (`src/video/`): test seven model contracts, correct Veo durations, no invented price, no submission on unknown price. Check with `node --test test/video-*.test.js`.
2. Voice (`src/voice/`, CLI dispatcher): catalog and speakers, paid commands with explicit consent, bounded input and secret-safe output. Check with `node --test test/voice-*.test.js`; use protocol fixtures, never real credentials.
3. Desktop (`app/`, `app-macos/`): show supported capabilities and credential setup; separate speaker from model and confirm charge. Verify native CLI arguments, Swift build and KitChecks.
4. Integration: preserve picker guard, document limitations, review and run regression tests. No push, signing or deploy.
