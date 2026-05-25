# Spike: Legacy v2 SDK Session ID Parser Drops Users With Hyphens

**Status:** Open — fix shipped with this PR
**Date:** 2026-05-19
**Related:**
- [074-sdk-v3-merge-and-ship](../074-sdk-v3-merge-and-ship/) — context for the v3 SDK refactor that preserved this bug

---

## Summary

The cloud's legacy v2 SDK session ID parser uses `sessionId.indexOf("-")` (previously `sessionId.split("-")[0]`) to extract the userId portion. The v2 SDK wire format is `<userId>-<packageName>` where userId is always an email, so when either side contains a hyphen the parser silently extracts the wrong substring.

For a user `a-b@example.com` running `some-app-name`, the session ID is

```
a-b@example.com-some-app-name
 ↑
 first hyphen at position 1
```

`indexOf("-")` returns 1, so the parser extracts `userId = "a"` and `packageName = "b@example.com-some-app-name"`. `UserSession.getById("a")` returns undefined, the cloud closes the WS upgrade with `1008 "Session not found"`, the app SDK retries, and the cycle repeats indefinitely.

**Anyone with a hyphen anywhere in their email (local-part or domain) has been silently broken since this code shipped.** The bug predates the SDK v3 refactor and was carried forward into the current `parseUserIdFromLegacySessionId` / `parsePackageNameFromLegacySessionId` helpers in [bun-websocket.ts:1034-1058](../../packages/cloud/src/services/websocket/bun-websocket.ts#L1034).

---

## Evidence

### Cloud-side symptoms

The "User session not found for app message" log lines surface with truncated single-character userIds (e.g. `userId="a"`, `userId="x"`) — the parser truncated a hyphenated email at the first hyphen and the resulting prefix matches no live session.

### App-server-side symptoms

A v2 SDK app server attempting to serve a hyphenated-email user logs a tight retry loop:

```
Received session request for user a-b@example.com, session a-b@example.com-some-app-name
Attempting to connect to: wss://uscentralapi.mentra.glass/app-ws
Connection closed (code: 1008): Session not found
Connection timeout after 5000ms
Received session request for user a-b@example.com ...
[cycle repeats]
```

Every iteration of this loop adds load to the cloud's WS upgrade pipeline. With multiple legacy-format apps installed per affected user, the load multiplies.

### Why the v3 SDK path is unaffected

v3 SDK sends `userId` via the `x-user-id` HTTP header at upgrade time (see [bun-websocket.ts:171](../../packages/cloud/src/services/websocket/bun-websocket.ts#L171)). The parser is only invoked when both that header and `ws.data.userId` are absent — the v2 CONNECTION_INIT and RECONNECT paths.

---

## Historical Archaeology

The "dumb" approach the bug originates from is documented in the v3 SDK feat commit (`9a6c81ed6`):

> Before:
> ```ts
> const sessionParts = initMessage.sessionId.split("-");
> const userId = sessionParts[0];
> ```
> After:
> ```ts
> function parseUserIdFromLegacySessionId(sessionId?: string): string | undefined {
>   const separator = sessionId.indexOf("-");
>   if (separator <= 0) return undefined;
>   return sessionId.slice(0, separator);
> }
> ```

The refactor was cosmetic. Both versions take everything before the first hyphen.

Commit `cd91c2a28` from 2026-03-30 (`fix: pass legacy sessionId (userId-packageName) to AppSession for v2 SDK compat`) explicitly documents the legacy contract:

> "v2 SDKs send this sessionId in CONNECTION_INIT, and the cloud parses `sessionId.split("-")[0]` to recover the userId and find the UserSession."

The format is intentional. The parser was the bug.

---

## Constraints On The Fix

- **SDK is frozen.** The v2 SDK wire format cannot change. Anything that requires SDK-side changes is out of scope.
- **Backwards-compat.** Existing sessions, existing apps, and existing v2 SDK clients must all continue to work without intervention.
- **AppManager construction format unchanged.** `AppManager.ts:208` builds session IDs as `${userId}-${packageName}`; that string then needs to round-trip through the parser. Both pre-fix and post-fix sessions stored in MongoDB must parse correctly.

---

## Fix

Replace the `indexOf("-")` first-hyphen logic with validation-by-lookup, with a TLD-shape heuristic as the fallback:

1. Enumerate every possible split position of the input string.
2. Discard candidates whose userId-portion doesn't contain `@` (active user IDs are always emails).
3. For each remaining candidate, look up the userId in the live `UserSession` map.
4. If at least one candidate matches a live UserSession, return the longest matching candidate (handles the rare case where a shorter prefix is also a valid email for a different live user).
5. If none match, prefer the SHORTEST candidate whose userId ends with a TLD-shaped suffix (`/\.[a-zA-Z]{2,5}$/`) — anchors to the email's natural boundary so both the parsed userId AND the resulting packageName are correct.
6. If no candidate has a TLD-shaped userId (long gTLDs like `.museum`, IP-domain emails, internationalized TLDs), fall back to the SHORTEST `@`-bearing candidate — equivalent to pre-fix "first hyphen after `@`" parsing, which is correct for any non-hyphenated email regardless of TLD length and never regresses pre-fix behavior.

`UserSession.getById` is a `Map.get` — O(1). A typical legacy session ID has 2-5 hyphens, so we do at most ~5 lookups per parse. Microseconds.

The parser is extracted to its own module (`cloud/packages/cloud/src/services/websocket/legacy-session-id.ts`) with dependency injection on the lookup, so unit tests don't need a live UserSession.

See [spec.md](./spec.md) for the exact implementation and call-site changes.

---

## What's Eliminated By This Fix

- Users with a hyphen in their email local-part (e.g. `a-b@example.com`, `first-last@example.com`).
- Users with a hyphen in their email domain (e.g. `user@hyphen-domain.com`).
- The retry-loop CPU cost on cloud from affected users' apps repeatedly failing to connect.

---

## What's Not Fixed By This Fix

- The underlying v2 SDK retry behavior. v2 SDK apps will still retry tight (5-second timeout, no backoff) on `1008 SESSION_NOT_FOUND`. That's a known SDK characteristic and the SDK is frozen.
- Apps that are configured with stale session info during a real session-disposal race. The parser returning the right userId doesn't change the fact that `UserSession.getById` will still return undefined when the session is genuinely gone. Those cases need different handling (e.g. AppManager-side coalescing of webhook retries).

---

## Blast Radius

Any user with a hyphen anywhere in their email has been unable to use any v2 SDK app since this code shipped. A quick MongoDB query can size the affected population:

```js
db.users.countDocuments({ email: /-/ })            // any hyphen
db.users.countDocuments({ email: /^[^@]*-/ })      // hyphen in local-part
db.users.countDocuments({ email: /@[^@]*-/ })      // hyphen in domain
```

Worth running this against prod before merging to gauge impact. Even a small affected population is a real user-facing bug worth fixing immediately.

---

## Other Places Searched, No Bug Found

A codebase-wide search for `sessionId.split("-")` and `indexOf("-")` near sessionId/userId parsing returned only these two parser functions as having the bug. The other `split("-")` usages in the codebase are for language codes (`en-US` → `en`), which is a well-defined two-part format with no ambiguity. Not affected.

The older `cloud/packages/cloud/src/services/websocket/websocket-app.service.ts` contains a third copy of the broken parser (at line 201), but the file is confirmed dead code — no import path leads to it from `cloud/packages/cloud/src/index.ts`. Left untouched in this PR; should be deleted in a separate cleanup PR.
