# Spike: SDK v3 Merge & Ship

**Issue:** 074
**Related:** [048-sdk-v3](../048-sdk-v3/) (on `cloud/issues-048` branch), [073-rapid-disconnect-subscription-loss](../073-rapid-disconnect-subscription-loss/), [046-sdk-app-ws-liveness](../046-sdk-app-ws-liveness/)
**Status:** Spike
**Date:** 2026-03-31

---

## Overview

**What this doc covers:** The plan to merge the SDK v3 branch (`cloud/issues-048`) into `dev`, finish the remaining cloud-side implementation, ship it, promote the SDK to `latest`, and upgrade internal apps — including a v2 hotfix for the subscription loss bug (073) that works with all existing SDKs.

**Why this matters:** The SDK v3 reconnection architecture eliminates the entire class of bugs we've been fighting for a year — subscription loss on reconnect, resurrection destroying app state, timing races between SDK backoff and cloud grace periods, idle `app-ws` connections dying silently. Every week we delay shipping v3 is another week where users experience "captions stopped but the app looks like it's running."

**Key insight from 073:** The `app-ws` between mini apps and the cloud dies when the `glasses-ws` drops — not because of the same network event, but because **data stops flowing and the connection goes idle**. SDK 2.x apps have no ping/pong to keep the `app-ws` alive. When the `app-ws` dies, resurrection wipes subscriptions, and the whole recovery chain fails. V3 fixes this at every layer (ping/pong, TRANSPORT_DOWN, subscription reconciliation). But we need a v2 hotfix on the same branch for backward compat.

---

## Current State of Both Branches

### `dev` (production)

Contains all stability work from issues 055–072:
- Memory leak fixes (057)
- Graceful shutdown (063)
- MongoDB in-memory cache (062)
- ResourceTracker crash fix (068)
- Soniox timeout crash fix (070)
- WS disconnect observability (066, 069)
- Vector logging / heap growth fix (067)
- Cloudflare 521 baseline (072)
- Cloud-side ping/pong handler for `app-ws` (046) — deployed, but only v3 SDKs send pings
- Camera FOV/ROI SDK additions (recent)

### `cloud/issues-048` (v3 branch)

Contains all SDK v3 work:
- **SDK runtime** ✅ — MentraSession, 14 managers, transport abstraction, v2 compat shims
- **SDK _ConnectionManager** ✅ — ping/pong every 15s, reconnect logic, parked state
- **SDK _SubscriptionManager** ✅ — microtask batching, sync(), handler-derived subscriptions
- **SDK MiniAppServer** ✅ — webhook handling, session lifecycle, v2 compat via AppServer
- **Cloud DeferredAppConnectionRegistry** ✅ — built, handles cloud restart/boot scenario
- **Cloud bun-websocket.ts changes** ✅ — RECONNECT routing, sdkVersion detection, deferred attach
- **Cloud AppManager changes** ✅ — handleReconnect(), v3-aware resurrection
- **Cloud AppSession changes** — partial (sessionId UUID added, but TRANSPORT_DOWN state not yet implemented)
- **Subscription reconciliation in CONNECTION_ACK** — not yet implemented
- **v3 smoke test app** ✅ — working

### Divergence

Checked via `git merge-tree`:

| Direction | Commits | Conflict surface |
|-----------|---------|-----------------|
| `dev` has, `048` doesn't | 7 cloud, 3 SDK | Camera FOV/ROI, formatting, minor fixes |
| `048` has, `dev` doesn't | 1 cloud, 5 SDK | v3 runtime, managers, shims, cloud bootstrap |
| **Merge conflicts** | **1 file** | `sdk/src/types/messages/app-to-cloud.ts` — formatting (semicolons) + v3 additions (AppReconnect, sdkVersion) |

The merge is clean. One trivial conflict.

---

## The 073 Root Cause (Why This Is Urgent)

Traced line-by-line in the 073 investigation:

```
glasses-ws dies
  → no audio flows from phone to cloud
  → no transcription/translation results generated
  → cloud has nothing to send to the mini app
  → app-ws goes idle (SDK 2.x has no ping/pong)
  → infrastructure kills the idle app-ws (~20-30s)
  → cloud-side AppSession enters GRACE_PERIOD → 5s → RESURRECTING
  → stopApp(pkg, restart=true) calls removeSubscriptions() → subscriptions wiped to EMPTY
  → startApp() → webhook → SDK reconnects → handleConnect() reuses AppSession
  → SDK sends empty subscription_update (before onSession registers handlers)
  → grace window blocks it (length === 0 && timeSinceReconnect <= 8000ms)
  → subscriptions stay EMPTY
  → SDK's onSession registers handlers → sends non-empty subscription_update
  → BUT if the app-ws dies again before this arrives, or the app is slow to register...
  → MicrophoneManager: "no subscriptions, forcing mic off"
  → translation stream starved → captions silently stop
```

Two compounding bugs:
- **Bug A:** app-ws dies because SDK 2.x has no ping/pong and data flow stopped
- **Bug B:** resurrection needlessly wipes subscriptions via removeSubscriptions()

V3 fixes Bug A (ping/pong keeps app-ws alive) and eliminates Bug B entirely (TRANSPORT_DOWN preserves subscriptions, RECONNECT protocol avoids empty subscription window).

But existing 2.x apps need Bug B fixed on the cloud side. That fix (`stopApp(restart=true)` skips `removeSubscriptions()`) is a one-liner that works with all SDK versions.

---

## The Plan

### Phase 1: Merge `dev` → `cloud/issues-048`

**Goal:** Get all production stability fixes onto the v3 branch.

**Work:**
1. `git merge dev` on the `cloud/issues-048` branch
2. Resolve the one conflict in `app-to-cloud.ts` — take the 048 version (has v3 types + semicolons), add any new types from `dev` if any
3. Build, verify types compile: `bun run build` from `cloud/packages/sdk/`
4. Verify cloud compiles: `bun run build` from `cloud/packages/cloud/`

**Risk:** Low. One trivial conflict. The branches changed mostly different files.

**Estimated effort:** 30 minutes.

### Phase 2: v2 Hotfix — Preserve Subscriptions During Resurrection

**Goal:** Fix the 073 subscription loss for all existing SDK versions. Cloud-side only.

**Work:**

In `AppManager.stopApp()`, skip `removeSubscriptions()` when `restart === true`:

```typescript
// In AppManager.stopApp():
// DON'T wipe subscriptions during resurrection — old subs are better than no subs.
// The mini app will send a SUBSCRIPTION_UPDATE when it reconnects, which will
// overwrite stale subs with the correct ones. If it never sends one (old SDK,
// crash, connection dies again), old subs keep data flowing.
// See: cloud/issues/073-rapid-disconnect-subscription-loss
if (!restart) {
  try {
    await this.userSession.subscriptionManager.removeSubscriptions(packageName);
  } catch (error) {
    this.logger.error(error, `Error removing subscriptions for ${packageName}`);
  }
}
```

Also skip `syncManagers()` inside `removeSubscriptions()` for the resurrection path — we don't want to tear down Soniox transcription/translation streams only to recreate them moments later.

**Why this is safe:**
- If the SDK sends real subscriptions on reconnect → they overwrite the stale ones → correct state
- If the SDK never sends subscriptions (old SDK, crash, dies again) → stale subscriptions stay → mic stays on → data keeps flowing → dramatically better than current behavior
- Worst case: stale subscriptions (e.g., wrong language pair) — user still gets data, just possibly the wrong language until the app stabilizes

**Backward compat:** Works with all SDK versions. No SDK changes needed.

**This fix must also be applied to the v2 legacy code path on the v3 cloud**, since v3 cloud will still serve v2 apps via `reconnectionMode === "legacy"`.

**Estimated effort:** 30 minutes including tests.

### Phase 3: Finish Cloud-Side v3 Implementation

**Goal:** The cloud can handle v3 SDK reconnection protocol.

The SDK side is built. The cloud side is partially built (DeferredAppConnectionRegistry, bun-websocket routing, AppManager.handleReconnect). What's missing:

#### 3a. `TRANSPORT_DOWN` state in AppSession

Add `TRANSPORT_DOWN` to `AppConnectionState` enum. When `handleDisconnect()` fires for a v3 app (`reconnectionMode === "v3"`):
- State → `TRANSPORT_DOWN` (not `GRACE_PERIOD`)
- **Do NOT clear subscriptions**
- **Do NOT null WebSocket reference** — wait, actually do null it (it's dead), but keep everything else
- Start the 5s timer (same as grace period, but subscriptions are preserved)
- If `RECONNECT` arrives within 5s → cancel timer, attach new WebSocket, state → `RUNNING`, send `RECONNECT_ACK`
- If timer fires → state → `RESURRECTING`, send webhook, **keep subscriptions alive**

For v2 apps (`reconnectionMode === "legacy"`): current behavior unchanged (GRACE_PERIOD, but with Phase 2 fix — no subscription wipe during resurrection).

#### 3b. Subscription reconciliation in ACK

Both `CONNECTION_ACK` and `RECONNECT_ACK` must include the cloud's current subscriptions:

```typescript
{
  type: "tpa_connection_ack",
  sessionId: "uuid",
  subscriptions: [...currentSubscriptions],  // NEW
  resurrected: boolean,                       // NEW
  // ... existing fields
}
```

The v3 SDK's `handleConnectionAck()` already calls `this._subscriptions.sync()` after receiving the ACK — this sends the full subscription set. The cloud compares and applies. No grace window needed.

For v2 SDKs: they ignore the new fields in the ACK (unknown fields are harmless). No change to their behavior.

#### 3c. `sdkVersion` detection and `reconnectionMode`

Already partially implemented in 048's `bun-websocket.ts`. Verify that:
- `CONNECTION_INIT` with `sdkVersion >= 3.0.0` → `reconnectionMode = "v3"`
- `CONNECTION_INIT` without `sdkVersion` → `reconnectionMode = "legacy"`
- `RECONNECT` message (only sent by v3) → find AppSession by `sessionId`, attach

#### 3d. Don't call `syncManagers()` during `TRANSPORT_DOWN`

When an app enters `TRANSPORT_DOWN`, the cloud must NOT tear down upstream provider streams (Soniox transcription, Soniox translation). These streams should stay alive so data resumes instantly on reconnect. `syncManagers()` is called inside `removeSubscriptions()` and `handleSubscriptionChange()` — make sure neither fires during `TRANSPORT_DOWN`.

**Estimated effort:** 1–2 days.

### Phase 4: Fix Known Bugs on 048 Branch

From the implementation status doc, 3 must-fix bugs:

| Bug | Location | Fix | Effort |
|-----|----------|-----|--------|
| LocationManager memory leak | `LocationManager.ts` | Store `updateCleanup` in Registration struct, call in cleanup | 30 min |
| SubscriptionManager sends N updates | `_SubscriptionManager.ts` | Already fixed — `queueMicrotask()` batching is implemented | ✅ Done |
| Missing v2 compat methods | `_V2SessionShim.ts` | Add ~15 delegating methods (getSettings, subscribe, etc.) | 2 hours |

**Estimated effort:** 3 hours.

### Phase 5: Test

**Goal:** Verify v3 SDK + cloud works, and v2 backward compat is intact.

#### Test matrix

| Scenario | SDK version | Expected behavior |
|----------|------------|-------------------|
| Fresh start | v3 | CONNECTION_INIT → ACK with subs → SDK syncs → data flows |
| Fresh start | v2 | CONNECTION_INIT → ACK → SDK sends subs → data flows (unchanged) |
| Transport blip (app-ws dies, recovers <5s) | v3 | TRANSPORT_DOWN → RECONNECT → RECONNECT_ACK → subs preserved → instant resume |
| Transport blip (app-ws dies, recovers <5s) | v2 | GRACE_PERIOD → SDK reconnects → CONNECTION_INIT → subs preserved (Phase 2 fix) |
| Resurrection (app-ws dead >5s) | v3 | TRANSPORT_DOWN → 5s → RESURRECTING → webhook → SDK connects → subs in ACK → reconcile |
| Resurrection (app-ws dead >5s) | v2 | GRACE_PERIOD → 5s → RESURRECTING → webhook → SDK connects → **subs preserved** (Phase 2 fix) |
| glasses-ws dies, app-ws stays alive | v3 | app-ws kept alive by ping/pong. Data pauses, resumes when glasses-ws reconnects. No app-ws disruption. |
| glasses-ws dies, app-ws goes idle and dies | v2 | No ping/pong → app-ws dies → resurrection → **subs preserved** (Phase 2 fix) → recovery |
| Cloud restart | v3 | RECONNECT_DEFERRED → SDK parks → cloud rebuilds → reattach |
| Cloud restart | v2 | Session lost → glasses-ws reconnects → apps resurrected (current behavior) |
| Multi-cloud switch | v3 | OWNERSHIP_RELEASE to old cloud → connect to new cloud → old cloud marks DORMANT |
| Multi-cloud switch | v2 | Same as current behavior |

#### Test environments

1. **Debug cloud** — deploy branch, test with v3 smoke test app + existing v2 apps
2. **Simulated 073 scenario** — start translation on v2 app, kill glasses-ws, verify app-ws behavior and subscription recovery
3. **Simulated 073 scenario on v3** — same test, verify app-ws stays alive via pings, no subscription disruption

**Estimated effort:** 1 day.

### Phase 6: Ship

1. Merge `cloud/issues-048` → `dev`
2. Deploy to staging, then production (all regions)
3. `npm publish @mentra/sdk@3.0.0 --tag latest` (promote from `hono` tag to `latest`)
4. Keep `@mentra/sdk@2.1.29` available (don't unpublish — existing apps need it)
5. Update app templates / starter kits to use v3 API
6. Update developer documentation (spec exists: `docs-update-spec.md` on 048 branch)

### Phase 7: Upgrade Internal Apps

Upgrade Mentra's own mini apps to SDK v3:
- `com.mentra.translation`
- Live captions
- Any other Mentra Store apps running on 2.x

This is critical — `com.mentra.translation` is the exact app that failed in 073. Upgrading it to v3 means it gets ping/pong (Bug A fix) AND the v3 reconnection protocol. It becomes resilient to the exact failure pattern Cayden experienced.

**Estimated effort:** 1 day per app (mostly mechanical — change class inheritance to callback pattern, rename session.audio → session.speaker, etc.). The v2 compat shim means apps can upgrade incrementally.

---

## What v3 Adds to 048's Reconnection Spike (From 073 Investigation)

Three gaps we identified in the 073 investigation that should be noted in the 048 spike:

### 1. Document the `glasses-ws` → idle `app-ws` → infrastructure kill cascade

The 048 reconnection spike covers `app-ws` dying due to network blips, app crashes, and cloud restarts. It does NOT explicitly call out this cascade:

```
glasses-ws dies
  → data stops flowing to mini app
  → app-ws goes idle (no ingress or egress)
  → infrastructure kills idle app-ws (Cloudflare/LB timeout ~20-30s)
```

The v3 fix (ping/pong every 15s) prevents this by maintaining bidirectional traffic regardless of data flow. This should be documented as a **design invariant**: the `app-ws` must stay alive independently of the `glasses-ws`. Ping/pong is the mechanism. If anyone ever removes or weakens the ping interval, this failure mode returns.

### 2. v2 backward-compat path on v3 cloud must preserve subscriptions

When `reconnectionMode === "legacy"`, the resurrection path should skip `removeSubscriptions()` (Phase 2 fix). The 048 spike says v2 behavior is "unchanged" — but it should be "unchanged except for the subscription preservation fix." This makes v2 apps more resilient even on the new cloud.

### 3. `TRANSPORT_DOWN` must not trigger upstream stream teardown

During `TRANSPORT_DOWN`, the cloud must NOT call `syncManagers()` or tear down Soniox transcription/translation streams. The streams should be held alive through the 5-second window. If the SDK reconnects, data resumes instantly — no stream recreation latency. If resurrection is needed, the streams are still there for the new connection. Only tear down on `STOPPED`.

---

## Effort Summary

| Phase | Work | Effort |
|-------|------|--------|
| 1. Merge dev → 048 | One trivial conflict | 30 min |
| 2. v2 hotfix (preserve subs) | One code change + tests | 30 min |
| 3. Cloud-side v3 implementation | TRANSPORT_DOWN, ACK subs, sdkVersion | 1–2 days |
| 4. Fix known bugs | LocationManager leak, v2 compat methods | 3 hours |
| 5. Test | Debug deploy, scenario testing | 1 day |
| 6. Ship | Merge, deploy, npm publish, docs | Half day |
| 7. Upgrade internal apps | Translation, captions, etc. | 1 day per app |

**Total to ship v3 to production: ~4-5 days.**
**Total to upgrade all internal apps: +2-3 days after.**

---

## What We Work On Today

Priority order:

1. **Phase 1: Merge `dev` → `cloud/issues-048`** — unblocks everything, 30 minutes
2. **Phase 2: v2 hotfix** — one-liner in `stopApp()`, immediately fixes 073 for all existing apps
3. **Phase 3: Start cloud-side v3 implementation** — TRANSPORT_DOWN state is the highest-value piece (the rest of the reconnection protocol depends on it)

If we get through 1-2 today and start 3, we're in good shape. The v2 hotfix alone is worth deploying — it fixes the user-facing 073 bug for every app in the ecosystem without requiring any SDK upgrades.

---

## Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Should we deploy the v2 hotfix to prod independently?** | We could cherry-pick the `stopApp` subscription fix to `dev` and deploy it today, without waiting for the full v3 merge. This fixes 073 for all users immediately. |
| 2 | **v3 SDK version number — 3.0.0 or 3.0.0-rc.1?** | Current `hono` tag is `3.0.0-hono.8`. Do we go straight to `3.0.0` for the `latest` promotion, or do an RC first? |
| 3 | **Do we need to notify third-party developers?** | When we promote v3 to `latest`, any `npm install @mentra/sdk` gets v3. The v2 compat shim (AppServer class inheritance still works) should make this non-breaking, but worth a changelog / migration guide. |
| 4 | **Deferred attach registry — ship in v3.0.0 or defer?** | The `DeferredAppConnectionRegistry` handles cloud restart gracefully, but it's a complex new subsystem. Could ship v3.0.0 without it and add in v3.1 if we want to reduce risk. |