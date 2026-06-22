# Subscription seed overlap: new session blocked by a lingering key

## Symptom

When a new WebSocket session handshakes while Redis still holds a DIFFERENT
session's `{user}:subscriptions` record (dead socket not yet reaped, or a slow
close on another pod), `seedSubscriptions` correctly refuses to clobber it —
but then every REST subscription write from the new session is rejected as
`stale-session`. The new session runs without reconciled subscriptions until
the old key TTLs out (up to 60s) or the old socket closes cleanly.

Flagged by PR #2766 review (Cursor bugbot, medium). Related hardening already
landed: same-session reseeds no longer reset the version, and teardown deletes
are now conditional on session ownership of the key — which shrinks this
window (a clean close or lost-ownership drop can no longer wipe a NEWER
session's seed, and the stale key is removed promptly when its owner closes).

## The remaining question

Should a NEW handshake take over the key from a DIFFERENT session?

- **Current semantics (protect existing)**: first live seed wins; a second
  concurrent socket for the same user defers. Safe for multi-socket users, but
  a dead socket's key blocks its replacement for up to TTL.
- **Newest-wins**: `connection.init` always re-seeds (new sessionId, version
  0). The version/session guard then correctly rejects the OLD socket's late
  writes as stale-session — which is the desired outcome if the old socket is
  dead, and a subscription theft if it is alive (how real is multi-socket per
  user in practice?).
- **Middle path**: seed normally; on conflict, check whether the recorded
  session is still registered (sessionTag registry / ownership) and take over
  only when it is not.

The middle path is the most correct but adds a cross-pod liveness check to the
handshake. If product reality is "one socket per user," newest-wins is simpler
and self-healing. Decision needed before changing handshake semantics.
