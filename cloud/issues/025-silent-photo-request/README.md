# Issue 025: Silent Photo Request

Cloud-controlled `silent` mode for photo requests to disable LED flash and shutter sound for AI apps.

## Documents

- **[silent-photo-spec.md](./silent-photo-spec.md)** - Problem, goals, implementation plan

## Quick Context

**Current**: Photo requests don't include `silent` flag. AI apps (Mira, MentraAI) trigger visible/audible camera feedback, which is disruptive for continuous capture.

**Proposed**: Cloud adds `silent: true` to photo requests from whitelisted package names. Not exposed to SDK developers—cloud controls this based on packageName.

## Key Context

The `silent` parameter already works end-to-end (Mobile → ASG Client → Glasses). The gap is that the Cloud doesn't set it. We'll add a hardcoded allowlist plus an optional env var for additional packages.

## Data Flow

```
App (SDK) → Cloud (PhotoManager) → Mobile (SocketComms) → Glasses (PhotoCommandHandler)
                    ↓
            Checks packageName against allowlist
            Sets silent: true if match
```

## Files to Modify

| File | Change |
|------|--------|
| `sdk/src/types/messages/cloud-to-glasses.ts` | Add `silent?: boolean` to `PhotoRequestToGlasses` |
| `cloud/src/services/session/PhotoManager.ts` | Add silent logic with allowlist |

## Status

- [x] Investigation complete
- [x] Issue documented
- [ ] Implementation
- [ ] Testing