# 0002 — Isolate paid video submissions from chat failover

Accepted for the video-routing worktree, 2026-11-21. The earlier media phase was parked. This decision covers only the explicitly requested video routes, not a general-purpose media gateway.

Use the existing DSHProxy CLI entry point with fixed upstream routes and process-scoped video API keys. Never send video jobs through the chat gateway: a retry after an ambiguous timeout can purchase two jobs. Never ingest Krea OAuth tokens: the external client owns that session. A caller may request an offline preflight handoff instead. No new local network listener or credential persistence. This trades transparent fallback and desktop controls for an auditable per-job choice. Any automatic failover, daily cap or account storage is a separate decision.
