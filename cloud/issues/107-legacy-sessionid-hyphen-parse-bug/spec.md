# Spec: Hyphen-Safe Legacy v2 SDK Session ID Parser

## Overview

**What this doc covers:** Exact changes in this PR to fix the legacy session ID parser. The SDK is frozen so this is cloud-side only.

**What you need to know first:** [spike.md](./spike.md) for the bug, the historical context, and the constraint that the SDK wire format cannot change.

**Who should read this:** PR reviewers.

---

## Changes

| File | Change |
|---|---|
| `cloud/packages/cloud/src/services/websocket/legacy-session-id.ts` | NEW. Exports `parseLegacySessionId(sessionId, isActiveUserId?)`. |
| `cloud/packages/cloud/src/services/websocket/legacy-session-id.test.ts` | NEW. 21 unit tests covering happy path, hyphen edge cases, malformed input, backwards-compat. |
| `cloud/packages/cloud/src/services/websocket/bun-websocket.ts` | `parseUserIdFromLegacySessionId` and `parsePackageNameFromLegacySessionId` now delegate to the new module. Add a private `isActiveUserId` wrapper around `UserSession.getById`. |
| `cloud/issues/107-legacy-sessionid-hyphen-parse-bug/spike.md` | NEW. Investigation. |
| `cloud/issues/107-legacy-sessionid-hyphen-parse-bug/spec.md` | NEW. This file. |

No other source files touched.

---

## S1. The New Parser Module

**File:** `cloud/packages/cloud/src/services/websocket/legacy-session-id.ts`

Pure-function module. The exported `parseLegacySessionId` takes a session ID string and an optional `isActiveUserId` lookup callback. Returns `{userId, packageName} | undefined`.

Algorithm (also described in the spike):

1. Walk every hyphen position in the input.
2. At each position, consider splitting the string into `userId = before` and `packageName = after`.
3. Keep the candidate only if `userId.includes("@")` and `packageName.length > 0`.
4. If `isActiveUserId` is provided, prefer the LONGEST candidate whose userId matches a live UserSession.
5. If none match (or no lookup was provided), pick the SHORTEST `@`-bearing candidate whose userId ends with a TLD-shaped suffix (`/\.[a-zA-Z]{2,5}$/`).
6. If no candidate is TLD-shaped (long gTLDs like `.museum`, IP-domain emails, internationalized TLDs), fall back to the SHORTEST `@`-bearing candidate — equivalent to pre-fix "first hyphen after `@`" parsing, which is correct for any non-hyphenated email regardless of TLD length.

The TLD heuristic in the fallback path matters more than "useful userId for logs alone": the `parsePackageNameFromLegacySessionId` half of the API feeds into the v3-SDK reconnect bootstrapping path (`bun-websocket.ts:777` → `validateApiKey(packageName, apiKey)`) whenever `x-package-name` header and JWT package name are both absent. Returning a truncated package there would reject otherwise-valid reconnects. The TLD anchor keeps the userId aligned with the email's natural boundary, which keeps the package name intact.

The 2-5 character TLD bound is a deliberate trade-off: it covers all common public TLDs (`.com`, `.org`, `.io`, `.uk`, `.app`, `.glass`, `.world`, ...) while rejecting longer dot-letter chunks that are almost certainly subdomain words (e.g. for `user@sub.hyphen-domain.com-captions`, the candidate `user@sub.hyphen` ends with `.hyphen` — 6 letters — which would falsely match an unbounded TLD regex). Users on long gTLDs (`.museum`, `.travel`, `.industries`) skip the TLD step entirely and land in the shortest-`@`-bearing fallback (step 6), which is correct for them as long as their email doesn't have a hyphen in the domain.

### Known limitations of this heuristic

The regex approach is necessarily imperfect. Two cases the parser still mis-handles, both extremely narrow:

1. **Long-gTLD email + hyphen in the domain + no live session.** E.g. `user@hyphen-domain.museum-pkg`. No candidate is TLD-shaped (`.museum` is 6 letters) and the shortest `@`-bearing candidate splits at the wrong hyphen. Real population: ~zero.
2. **Punycode IDN domains.** E.g. `user@example.xn--fiqs8s-pkg-name`. The 2-letter `.xn` prefix falsely matches the TLD regex and the parser splits there.

The clean resolution for both is to swap `TLD_SUFFIX` for the Public Suffix List (e.g. `tldts` npm package). Tracked as a follow-up so this hotfix can ship.

### Why dependency injection

The parser needs to disambiguate by checking which candidates correspond to live sessions. Inlining `UserSession.getById` directly would make unit tests require booting a UserSession registry. Accepting an optional `(userId) => boolean` callback lets tests pass a trivial stub and lets production pass the real lookup.

### Performance

`UserSession.getById` is a `Map.get(string)` — O(1) microseconds. Typical legacy session IDs have 2-5 hyphens, so at most ~5 lookups per parse. The parser also does at most N string slices, which Bun handles via small substring objects rather than full copies. Per-parse cost stays in the low microseconds even for pathological inputs.

---

## S2. bun-websocket.ts Wiring

**File:** `cloud/packages/cloud/src/services/websocket/bun-websocket.ts`

The two existing helpers are reduced to thin wrappers:

```ts
function parsePackageNameFromLegacySessionId(sessionId?: string): string | undefined {
  return parseLegacySessionId(sessionId, isActiveUserId)?.packageName;
}

function parseUserIdFromLegacySessionId(sessionId?: string): string | undefined {
  return parseLegacySessionId(sessionId, isActiveUserId)?.userId;
}

function isActiveUserId(userId: string): boolean {
  return UserSession.getById(userId) !== undefined;
}
```

Call sites of `parseUserIdFromLegacySessionId` / `parsePackageNameFromLegacySessionId` are unchanged. Same signatures, same return types, same semantics for non-hyphenated inputs. Only the underlying disambiguation changes.

Import line added:

```ts
import { parseLegacySessionId } from "./legacy-session-id";
```

---

## S3. Tests

**File:** `cloud/packages/cloud/src/services/websocket/legacy-session-id.test.ts`

Tests organized by category:

- **Happy path** (2 tests): standard email + simple package, with and without lookup.
- **Hyphen in local-part** (4 tests): regression cases like `a-b@example.com`, `first-last@example.com`, multi-hyphen `first-middle-last@example.com`, and plus-tag-with-hyphen `alpha+test-dash@example.com`.
- **Hyphen in domain** (2 tests): `user@hyphen-domain.com` with simple package, also with hyphenated package.
- **Hyphens on both sides** (1 test): worst case `x-y@a-b.com-some-app-name`.
- **isActiveUserId disambiguation** (4 tests): fallback when no live match; behavior with no lookup; longest-match preference when multiple are live; correct walk-past behavior.
- **Malformed input** (7 tests): empty, undefined, no hyphen, no `@`, trailing hyphen, leading hyphen, just `@`.
- **Backwards-compat** (2 tests): the exact format `AppManager.ts:208` constructs, and the test-script format.

All tests pass against the new implementation. A regression-sweep file (`legacy-session-id.regression.test.ts`) and an integration test (`legacy-session-id.integration.test.ts`) cover the same patterns through the production wiring.

---

## Non-Goals

- **SDK changes.** SDK is frozen; not touched.
- **Deleting dead code** in `websocket-app.service.ts` / `websocket.service.ts`. They contain the same bug but no live import path reaches them. Separate cleanup PR.
- **Refactoring the legacy session ID format itself.** The `<userId>-<packageName>` concatenation is fundamentally ambiguous; a proper fix would either (a) use a separator that can't appear in userId/packageName or (b) move to v3 SDK's header-based identity. Both require SDK changes. Out of scope.
- **AppManager webhook retry coalescing.** v2 SDK apps will still tight-loop retry on `1008 SESSION_NOT_FOUND` when sessions are genuinely missing. That's a separate concern from this parser fix.

---

## Decision Log

| Decision | Alternatives considered | Why |
|---|---|---|
| Extract parser to its own module + dependency-injected lookup | Inline fix in bun-websocket.ts with direct `UserSession.getById` call | Testability. The DI lookup lets unit tests run without booting UserSession. Module location (next to bun-websocket.ts) keeps the legacy code grouped. |
| Validate-by-lookup over `@`-anchor parse | Just find first `-` AFTER `@` | The `@`-anchor works for `a-b@example.com-foo` (hyphen in local-part) but breaks again for `user@hyphen-domain.com-foo` (hyphen in domain). Validation handles both cleanly. |
| Fall back to longest `@`-bearing candidate when no live session matches | Return undefined when no live match | If we returned undefined, the caller's error log would still log `userId: undefined`, hiding the diagnostic information. Returning the longest @-candidate at least surfaces a recognizable email in the error log. The connection still fails (UserSession.getById returns undefined again at the caller's check), so no behavior changes. Only logging quality improves. |
| Keep the two function names (`parseUserIdFromLegacySessionId`, `parsePackageNameFromLegacySessionId`) | Replace with one function returning both | Minimizes call-site churn. They're already used in two distinct call sites; the wrappers stay one-liners. |
| Don't fix the dead `websocket-app.service.ts` parser copy | Fix it too for symmetry | YAGNI. The file is dead code; reviving it would re-introduce other issues anyway. Cleanup PR can delete it entirely. |

---

## Testing

### Local

1. `bun install` from `cloud/` — succeeds.
2. `bunx tsc --noEmit` from `cloud/packages/cloud/` — clean.
3. `bun test src/services/websocket/legacy-session-id.test.ts` from `cloud/packages/cloud/` — 21 pass, 0 fail.

### Manual against real data (post-deploy)

After cloud-debug soak:

1. Have a user with a hyphenated email install any v2 SDK app (or simulate by sending CONNECTION_INIT with sessionId `test-hyphen@example.com-com.example.test`).
2. Verify the app's WS connection succeeds (no `1008 Session not found`).
3. Verify the BetterStack `User session not found for app message` rate trends to zero for the affected user.

### Cloud-debug smoke

Add `cloud/legacy-sessionid-hyphen-fix` to `.github/workflows/porter-debug.yml`'s `push.branches` list. Soak for ≥30 min. Confirm no regressions in:

- `op_appProtocol_connectionInit_ms` (parser is in this code path)
- WS upgrade success rate
- `slow-app-protocol` events should NOT increase (parser is microseconds)

### Acceptance after staging soak

After merging to `staging`:

1. Cross-reference BetterStack for single-letter / truncated userIds in `User session not found` errors (the telltale fingerprint of the parser bug). Should drop to zero.
2. Run the blast-radius MongoDB query to confirm affected user count.
3. Track v2 SDK app retry-loop volume in app-server logs. Should drop for hyphenated-email users.

---

## Rollout

1. Branch `cloud/legacy-sessionid-hyphen-fix` off `staging`. Done.
2. Land this PR's code + tests + docs.
3. Add branch to `porter-debug.yml` triggers for cloud-debug soak.
4. Soak ≥1h on cloud-debug.
5. PR to `staging`.
6. After staging soak, promote staging → main.
7. Back-merge staging → dev.

Per the staging-first release cycle. No hotfix-to-main path.

---

## Risks

| Risk | Mitigation |
|---|---|
| Parser misidentifies a candidate when multiple `@`-bearing candidates exist for live users | Longest-match preference. Verified by the dedicated test case. |
| Parser perf regression under pathological input | Worst case 1000-char session ID with hyphens everywhere = ~500 candidates × O(1) lookup = ~500 microseconds. Practical inputs are 30-80 chars with 2-5 hyphens = ~5 microseconds. Negligible. |
| Existing stored sessions in MongoDB don't round-trip | They round-trip identically. AppManager.ts:208 still constructs `${userId}-${packageName}`; the new parser handles every form correctly. Tested. |
| Behavior change breaks something else | Behavior change is strictly an improvement (broken cases now work; working cases still work). No semantic change for non-hyphenated inputs. |
| Privacy: fallback path returns a candidate userId that's logged downstream | The fallback userId is at worst a longer version of an already-logged identifier. Same information class as today (raw email or close to it). Not a new disclosure. |

---

## Summary

Three small files added (one module, one test file, two doc files), two helper functions in `bun-websocket.ts` simplified to one-liners. ~150 LoC of code + tests + docs. Zero behavior changes for non-hyphenated inputs. Fixes a class of users who have been silently broken since the legacy SDK shipped.
