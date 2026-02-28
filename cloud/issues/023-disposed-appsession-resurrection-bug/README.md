# Disposed AppSession Resurrection Bug

AppSession resurrection fails with "Cannot track resources on a disposed ResourceTracker" when reusing a disposed session after SDK server restarts.

## Documents

- **disposed-appsession-bug-spec.md** - Problem analysis, root cause, reproduction steps
- **disposed-appsession-bug-architecture.md** - Fix implementation details

## Quick Context

**Current**: SDK sends `OWNERSHIP_RELEASE: clean_shutdown` on server restart → cloud disposes ResourceTracker but keeps AppSession in map as DORMANT → resurrection fails when SDK comes back up.

**Root Cause**: SDK should NOT send `OWNERSHIP_RELEASE` on `clean_shutdown`. It should only be sent for `switching_clouds` (multi-cloud handoff).

**Fix**: Two-part fix:
1. `AppManager.getOrCreateAppSession()` - Detect disposed sessions and create fresh ones (safety net)
2. `AppServer.cleanup()` - Don't send `OWNERSHIP_RELEASE` on shutdown (root cause fix)

## Key Context

`OWNERSHIP_RELEASE` was designed for multi-cloud handoffs ("don't resurrect, user moved to another cloud"). But it was incorrectly being sent on every graceful SDK shutdown, preventing resurrection when the server restarts.

## Status

- [x] Root cause identified: SDK incorrectly sends OWNERSHIP_RELEASE on clean_shutdown
- [x] Fix 1: `AppManager.getOrCreateAppSession()` detects disposed sessions
- [x] Fix 2: `AppServer.cleanup()` no longer sends OWNERSHIP_RELEASE
- [ ] Deploy and verify fix
- [ ] Add unit tests

## Reproduction

1. Have an app running on the cloud
2. Restart/redeploy the mini-app's SDK server
3. Wait for SDK to come back and try to reconnect
4. Error: "Cannot track resources on a disposed ResourceTracker"

## Related Issues

- **018-app-disconnect-resurrection** - Parent issue for resurrection lifecycle
- **019-sdk-photo-request-architecture** - Investigation that uncovered this bug