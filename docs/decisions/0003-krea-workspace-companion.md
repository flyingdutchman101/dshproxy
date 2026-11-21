# 0003 — Keep workspace OAuth in a separate single-send helper

Accepted for the video CLI release candidate, 2026-11-22. Extends 0002 for the user's explicitly selected signed-in path. The routing CLI still does not ingest workspace tokens or expose a listener. Ordinary workspace operations only exchange a narrow request and sanitized result with a fixed helper process. No tool autocorrection, fallback, browser automation, paid replay, or automatic login.

Only an explicit login in the Windows companion starts a temporary loopback callback, prints the PKCE consent URL and stores the resulting short-lived credential under the current Windows user. Treat that operation (and logout) as an account change, never as a test prerequisite. Current-user storage protects data at rest, not against processes running under the same user. The separate process is an application boundary, not an OS sandbox. Workspace expiry requires user action; the router cannot renew tokens or switch payment sources. Unsupported client/server contracts fail closed.

This avoids relying on model-driven tool invocation or on external CLIs that cannot guarantee exact tool names and no replay. Mock-only verification does not qualify a real workspace, payment outcome or authorization server behavior for release.
