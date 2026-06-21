# Spec: Soniox Fallback API Keys

## Environment

Existing:

```bash
SONIOX_API_KEY=primary-key
```

New:

```bash
SONIOX_FALLBACK_API_KEYS=fallback-key-a,fallback-key-b,fallback-key-c
```

`SONIOX_API_KEY` remains the preferred primary credential. Fallback keys are
comma-separated, trimmed, and deduplicated. Empty entries are ignored.

## Runtime Behavior

1. New transcription stream creation first tries the primary key when it is not
   cooling down.
2. If the primary key is unavailable or stream creation fails with a
   credential/limit/provider error, stream creation tries fallback keys.
3. Fallback keys are chosen round-robin among keys that are not cooling down.
4. No local max-concurrent accounting is used.
5. Errors are classified into cooldown classes:
   - concurrent stream limit: very short cooldown
   - request/rate limit: short cooldown
   - spend/account quota: long cooldown
   - invalid key/authentication: disabled for this process
   - transient/network/server: short cooldown
6. Logs include credential fingerprints only. Raw API keys must never be logged.
7. Existing transcription and translation retry behavior remains in place. A
   retry should create a new stream, which reselects a Soniox key from the pool.

## Non-Goals

- Per-key concurrency env vars.
- Cross-pod key usage coordination.
- New external state such as Redis for quota tracking.
