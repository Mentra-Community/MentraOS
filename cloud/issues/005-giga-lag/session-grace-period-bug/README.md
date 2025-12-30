# Session Grace Period - Server Switch Investigation

Investigation into captions stopping after apparent reconnect. **NOT A BUG** - was expected behavior.

## Documents

- **session-grace-period-spec.md** - Original investigation (now resolved)

## Quick Context

**Reported**: Captions stopped working, app appeared to still be running, mic was off when it should have been on.
**Actual Cause**: User switched from `cloud-debug` to `cloud-dev` server. Old session on `cloud-debug` cleaned up after grace period as expected.

## Key Context

Investigation revealed the user changed servers mid-session:

| Time | Server | Event |
|------|--------|-------|
| `01:21:46.135` | **cloud-debug** | Glasses connection closed |
| `01:21:46.232` | **cloud-dev** | "No active session found" (different server!) |
| `01:21:46.408` | **cloud-dev** | New session created |
| `01:22:46.135` | **cloud-debug** | OLD session disposed after 60s grace period |

This is **expected behavior** - each server maintains its own sessions. When you switch servers:
- Old server doesn't know about the new connection
- Old server's grace period expires normally
- New server creates fresh session

The `subscription_update: []` and app disposal were happening on the OLD server (`cloud-debug`) which was correctly cleaning up its stale session.

## Status

- [x] Investigated
- [x] Root cause identified (server switch, not a bug)
- [x] **RESOLVED** - No fix needed

## Lessons Learned

When debugging session issues, always check the `server` and `env` fields in logs to ensure you're looking at the same server instance.