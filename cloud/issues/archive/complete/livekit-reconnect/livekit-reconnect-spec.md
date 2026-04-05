# LiveKit Bridge Reconnection Spec

## Overview

When users rapidly switch between cloud servers (prod/debug/dev), the LiveKit Go bridge gets kicked out of rooms due to identity conflicts but never rejoins when reconnecting within the grace period, resulting in complete audio loss.

## Problem

### Core Issue

The LiveKit bridge fails to reinitialize on reconnection when:

1. User switches servers within 60s (grace period)
2. Old server's UserSession stays alive (zombie session)
3. New server's bridge kicks old bridge from LiveKit room (same identity)
4. User returns to old server within grace period
5. Session reconnects but bridge remains dead

### Evidence

**Better Stack Logs (2025-10-18):**

Cloud-prod session:

- 20:31:59 - Joined LiveKit room, participant_count: 2 ✅
- 20:32:00 - Audio stream started ✅
- 20:32:02 - PCM endianness detection (audio flowing) ✅
- User switches to cloud-debug

Cloud-debug session:

- Creates new session, new bridge joins with identity `cloud-agent:isaiah@mentra.glass`
- LiveKit kicks cloud-prod bridge (same identity conflict)
- Audio flows on cloud-debug ✅

User switches back to cloud-prod:

- Reconnects to existing session (grace period not expired)
- No "Joined LiveKit room" log
- No PCM endianness detection
- **Zero audio chunks received** ❌

### Technical Details

**LiveKit Behavior:**

- One participant per identity per room
- Identity: `cloud-agent:${userId}` (same across all servers)
- When new participant joins with same identity → kicks old participant
- Kicked participant connection closes, bridge stops receiving audio

**Grace Period Behavior:**

- UserSession enters grace period on disconnect (60s)
- Session kept alive to allow quick reconnection
- All managers (AudioManager, TranslationManager, etc.) stay initialized
- LiveKitManager stays initialized but bridge connection is dead

**Reconnection Flow:**

```
glasses_disconnect()
  → session.state = GRACE_PERIOD
  → 60s timer starts

glasses_reconnect() [within 60s]
  → session.state = ACTIVE
  → handleConnectionInit(reconnection: true)
  → LiveKit NOT reinitialized (already exists)
  → Bridge still dead from being kicked
```

### Constraints

- Grace period is essential for handling brief disconnects (network blips)
- Can't disable grace period (breaks other reconnection scenarios)
- Can't use same identity across servers (LiveKit limitation)
- Must maintain backward compatibility with existing sessions

## Goals

### Primary

1. **100% reconnection success** - Audio works after switching servers any number of times
2. **No race conditions** - Works regardless of grace period timing
3. **Maintain grace period** - Don't break quick reconnection for network blips

### Secondary

1. Fast reconnection (<2s to audio)
2. Clean logging for debugging
3. Minimal code changes

### Success Metrics

| Metric                           | Current    | Target     |
| -------------------------------- | ---------- | ---------- |
| Reconnection within grace period | 0% audio   | 100% audio |
| Time to audio on reconnect       | ∞ (broken) | <2s        |
| Server switch success rate       | ~50%       | 100%       |
| Memory leaks from zombie bridges | Unknown    | 0          |

## Non-Goals

- Changing LiveKit identity scheme (future work)
- Removing grace period
- Making bridges survive kicks (LiveKit doesn't support this)
- Per-server identities (architectural change)

## Proposed Solutions

### Option 1: Bridge Status RPC on Reconnect

**Approach:** On reconnect, query the bridge for room connectivity; if disconnected → rejoin; if connected → keep session. No teardown unless needed.

**Pros:**

- Preserves healthy bridges for ordinary network blips
- Deterministic per-server (no cross-region ambiguity)
- Fixes duplicate-identity kick path immediately

**Cons:**

- Requires a lightweight Status RPC (or extend HealthCheck)
- Need simple backoff to avoid rejoin storms

**Implementation:**

```typescript
async handleConnectionInit(reconnection: boolean) {
  if (reconnection && this.liveKitEnabled) {
    const status = await this.livekitManager?.getBridgeStatus();
    if (!status?.connected) {
      await this.livekitManager?.rejoinBridge(); // mint token + JoinRoom
    }
  }
}
```

### Option 2: Health Check Before Use

**Approach:** Check if bridge is still connected before using it.

**Pros:**

- Only reinitializes when needed
- Faster for normal reconnections

**Cons:**

- Need to implement health checking
- Async health check adds complexity
- Might miss edge cases

**Implementation:**

```typescript
async handleConnectionInit(reconnection: boolean) {
  if (reconnection && this.liveKitEnabled) {
    const healthy = await this.livekitManager?.healthCheck();
    if (!healthy) {
      await this.livekitManager?.dispose();
      await this.initializeLiveKit();
    }
  }
}
```

### Option 3: Dispose Bridge on Grace Period Entry

**Approach:** Clean up bridge immediately when entering grace period.

**Pros:**

- Bridge never in dead state
- Reinitialize always starts fresh

**Cons:**

- Breaks quick reconnection (network blips require full bridge restart)
- Defeats purpose of grace period

### Option 4: Per-Server Identities

**Approach:** Use `cloud-agent-prod:user`, `cloud-agent-debug:user` identities.

**Pros:**

- No kicks, no conflicts
- All servers can coexist

**Cons:**

- Multiple bridges in same room (confusing)
- Need to clean up abandoned bridges
- Architectural change

## Recommendation

**Option 1: Bridge Status RPC on Reconnect**

Reasoning:

- Avoids killing healthy bridges during common network blips
- Deterministic: scoped to the owning server/session (no webhook ambiguity)
- Rejoins immediately when the bridge was kicked by a duplicate identity
- Minimal code surface; can be extended later with push events
- Meets <2s time-to-audio on reconnect in the typical case

## Open Questions

1. **What about in-progress audio streams?**
   - Need to handle gracefully (wait for drain or abort?)
   - **Decision needed**

2. **Should we track why bridge died?**
   - Add logging for "kicked by LiveKit" vs "timeout" vs "crash"
   - **Nice to have, not required for fix**

3. **Do we need backoff/retry?**
   - If bridge fails to join, should we retry or fail fast?
   - **Decision: Fail fast, user will see error**

4. **Memory leak from old bridges?**
   - Ensure dispose() fully cleans up Go bridge goroutines
   - **Need to verify with memory profiling**

5. **Token expiry during reconnection?**
   - If user was disconnected 50s, token might expire (TTL=10min default)
   - **Already handled by token refresh in LiveKitManager**

## Testing Plan

1. **Rapid server switching:**
   - prod → debug → prod (within 10s)
   - Verify audio works on final prod connection

2. **Grace period boundary:**
   - prod → debug → wait 59s → prod
   - Verify audio works

3. **Post-grace period:**
   - prod → debug → wait 65s → prod
   - Verify audio works (new session path)

4. **Multiple switches:**
   - prod → debug → prod → debug → prod (all within 60s)
   - Verify audio on each connection

5. **Network blip simulation:**
   - Disconnect for 2s, reconnect to same server
   - Verify audio restarts quickly

## Rollout Strategy

1. Implement Option 1 on feature branch
2. Test locally with rapid server switches
3. Deploy to cloud-debug first
4. Test with multiple users switching servers
5. Deploy to cloud-prod
6. Monitor for issues (check memory, reconnection success rate)
7. If problems: Can easily revert (single code path change)

## Success Criteria

- User can switch prod→debug→prod any number of times: audio always works
- No increase in memory usage from zombie bridges
- Reconnection time <2s
- No regressions for normal reconnection scenarios
