# 033: SDK Hono Merge — Port Dev Bug Fixes to Hono Branch

Complete the Express→Hono SDK refactor by merging all `dev` bug fixes into `cloud/sdk-hono`.

## Documents

- **[sdk-hono-merge-spec.md](./sdk-hono-merge-spec.md)** - Problem, goals, what needs porting
- **[sdk-hono-merge-architecture.md](./sdk-hono-merge-architecture.md)** - Conflict resolution details, file-by-file changes

## Quick Context

**Problem**: The Hono SDK branch (`cloud/sdk-hono`) diverged from `dev` on Jan 1. Since then, `dev` accumulated 14 commits of critical bug fixes (photo reconnection, session resurrection, zombie cleanup, etc.) that touch the same files the Hono refactor rewrote.

**Solution**: Merge `dev` into `cloud/sdk-hono`, resolve conflicts keeping Hono architecture + dev's bug fix logic, then verify the SDK builds and types are correct.

## Key Context

The Hono branch already had partial ports of the photo reconnection fix (`c97fe69c6`) and some type updates (`0892d3362`). The merge needed to reconcile ~30 conflicts in `server/index.ts` alone — every one resolved by keeping Hono patterns (`c.json`, `c.req.json`, `extends Hono`, no Express/multer/cookie-parser) while integrating dev's session lifecycle logic (OWNERSHIP_RELEASE, wasClean, identity-safe cleanup).

## Status

- [x] Identify branch: `origin/cloud/sdk-hono`
- [x] Analyze divergence: 14 dev commits touching SDK since merge base
- [x] Merge dev into cloud/sdk-hono
- [x] Resolve `cloud/packages/sdk/package.json` — keep Hono deps + version 3.0.0-hono.3
- [x] Resolve `cloud/packages/sdk/src/app/server/index.ts` — 30+ conflicts
- [x] Resolve `cloud/packages/sdk/src/app/session/modules/camera.ts` — 10 conflicts
- [x] Resolve `cloud/packages/sdk/src/index.ts` — add PreviewImage/PhotoOrientation exports
- [x] Resolve `cloud/packages/cloud/.../SonioxTranscriptionProvider.ts` — trivial
- [x] Resolve `cloud/bun.lock` — take dev's version
- [x] Commit merge
- [ ] Verify SDK builds: `cd cloud/packages/sdk && bun run build`
- [ ] Verify types compile: `cd cloud/packages/sdk && bun x tsc --noEmit`
- [ ] Verify cloud builds with new SDK
- [ ] Test photo capture flow end-to-end
- [ ] Test session reconnection (disconnect/reconnect cycle)
- [ ] Test clean shutdown + resurrection
- [ ] Publish `@mentra/sdk@3.0.0-hono.3` for testing