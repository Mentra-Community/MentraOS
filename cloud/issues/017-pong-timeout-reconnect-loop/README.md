# Pong Timeout Reconnect Loop

Audio gap reconnects trigger pong timeouts, creating a death spiral that kills user sessions.

## Documents

- **README.md** - This file (problem analysis, evidence, proposed fixes)

## Quick Context

**Current**: Audio gap detection sends CONNECTION_ACK → phone busy processing LiveKit reconnect → phone doesn't respond to pings → cloud kills WebSocket as "zombie" → session enters grace period → repeat until session dies

**Observed**: 13-minute outage for user, cycle repeated ~10 times before session finally recovered after full disposal and fresh session creation

## Problem

When audio stops flowing, our new audio gap detection (018) correctly identifies the issue and sends a CONNECTION_ACK with fresh LiveKit credentials. However:

1. Phone receives CONNECTION_ACK and starts LiveKit reconnection
2. LiveKit reconnection is CPU/network intensive
3. Phone becomes unresponsive to WebSocket pings during this time
4. Cloud's pong timeout (30s) fires and closes WebSocket as "zombie"
5. Session enters grace period
6. Phone eventually reconnects, but audio still doesn't flow
7. Audio gap detected again → cycle repeats

### Evidence from Production (2025-12-25)

User `isaiahballah@gmail.com` on staging:

| Time        | Transcriptions/min | Events                                              |
| ----------- | ------------------ | --------------------------------------------------- |
| 01:20-01:24 | 13-26              | Normal operation                                    |
| 01:26       | 9                  | First audio gap detected, reconnect sent            |
| 01:27-01:34 | 0-3                | Death spiral: gap→reconnect→pong timeout→disconnect |
| 01:35-01:36 | 0                  | Grace period, session disposed                      |
| 01:37-01:38 | 1                  | New session, still unstable                         |
| 01:39+      | 21                 | Finally recovered                                   |

**Total outage: ~13 minutes**

### Log Pattern

```
01:30:14 - Audio gap detected with active subscriptions - triggering LiveKit reconnect
01:30:14 - Sent CONNECTION_ACK to trigger client LiveKit reconnect
01:30:42 - Audio gap detected but in cooldown period - skipping reconnect
01:30:43 - [UserSession:pongTimeout] Phone connection timeout - no pong for 30000ms
01:30:43 - [UserSession:pongTimeout] Closing zombie WebSocket connection
01:30:43 - Glasses WebSocket closed (code 1001)
```

This pattern repeated 10+ times.

### Pattern Frequency Analysis (Last 6 Hours)

Checked correlation between pong timeouts and audio gap reconnects:

| User                           | Pong Timeouts | Audio Gap Reconnects | Server     |
| ------------------------------ | ------------- | -------------------- | ---------- |
| isaiahballah@gmail.com         | 30            | 18                   | staging    |
| haran_gopal@yahoo.com          | 2             | 42                   | staging    |
| nathanltwongbusiness@gmail.com | 75            | 0                    | production |
| isaiahellis1234@gmail.com      | 38            | 0                    | production |
| miisteryellow@gmail.com        | 32            | 0                    | production |

**Key findings:**

1. **Most pong timeouts are NOT caused by our audio gap detection** - Production users have many pong timeouts but 0 audio gap reconnects (feature not deployed there yet)

2. **The death spiral only happened to one user (isaiahballah@gmail.com)** - 30 pong timeouts correlated with 18 reconnects

3. **Another staging user (haran_gopal@yahoo.com) had 42 reconnects but only 2 pong timeouts** - The reconnects worked correctly for them, audio kept flowing (10-29 transcriptions/minute)

4. **Pong timeouts are a pre-existing widespread problem** - Hundreds of timeouts across many users on production, unrelated to our feature

### Why Death Spiral Happened for One User But Not Another

Comparing the two staging users:

| Metric                           | isaiahballah (death spiral)             | haran_gopal (healthy)       |
| -------------------------------- | --------------------------------------- | --------------------------- |
| Reconnects                       | 18                                      | 42                          |
| Pong timeouts                    | 30                                      | 2                           |
| Transcriptions during reconnects | 0-3/min                                 | 10-29/min                   |
| Pattern                          | Gap→reconnect→timeout→disconnect→repeat | Gap→reconnect→audio resumes |

Possible explanations:

- Different phone models/OS versions
- Different network conditions
- Different LiveKit reconnection behavior
- Client-side app state differences

## Root Cause Analysis

Two mechanisms fighting each other:

1. **Audio gap detection** (new, 018) - Sends CONNECTION_ACK when audio stops for 5s
2. **Pong timeout** (existing) - Kills WebSocket if no pong for 30s

The CONNECTION_ACK triggers LiveKit reconnection which makes the phone unresponsive long enough to trigger pong timeout.

### Why Recovery Eventually Worked

1. Old session fully disposed after grace period expired
2. New session created with clean state
3. After several reconnect cycles, phone eventually stabilized
4. Audio flow resumed

## Proposed Solutions

### Option A: Pause Pong Timeout During Reconnect (Recommended)

When we send a CONNECTION_ACK for audio gap recovery:

1. Temporarily disable/extend pong timeout for that session
2. Wait for audio to resume OR timeout (e.g., 60s)
3. Re-enable pong timeout

```typescript
// In AudioManager.triggerLiveKitReconnect()
this.userSession.pausePongTimeout(60000) // 60s grace for reconnection
websocket.send(JSON.stringify(ackMessage))
```

**Pros**: Gives phone time to complete LiveKit reconnection
**Cons**: Delays detection of truly dead connections during reconnect

### Option B: Don't Send CONNECTION_ACK, Only Rejoin Bridge

Instead of triggering client-side LiveKit reconnection, only rejoin the server-side bridge:

```typescript
// Current (causes issues):
await this.userSession.liveKitManager?.rejoinBridge?.()
websocket.send(JSON.stringify(ackMessage)) // This triggers client reconnect

// Proposed:
await this.userSession.liveKitManager?.rejoinBridge?.()
// Don't send CONNECTION_ACK - just fix server side
```

**Pros**: No client-side reconnection, no pong timeout risk
**Cons**: Won't fix client-side LiveKit issues (only server-side bridge issues)

### Option C: Smarter Gap Detection

Don't trigger reconnect if we recently received a pong (phone is alive, just not sending audio):

```typescript
private checkForAudioGap(): void {
  // If we got a pong recently, phone is alive - audio issue is elsewhere
  const timeSinceLastPong = Date.now() - this.userSession.lastPongTime;
  if (timeSinceLastPong < 10000) {
    this.logger.debug("Phone responsive (recent pong), skipping reconnect");
    return;
  }
  // ... existing logic
}
```

**Pros**: Avoids reconnect when phone is clearly alive
**Cons**: May miss cases where phone is alive but LiveKit is broken

### Option D: Reduce Reconnect Aggressiveness

Increase cooldown and add max retry limit:

```typescript
private readonly RECONNECT_COOLDOWN_MS = 60000; // 60s instead of 30s
private readonly MAX_RECONNECT_ATTEMPTS = 3; // Stop after 3 tries
```

**Pros**: Limits damage from reconnect loops
**Cons**: Doesn't fix root cause, just limits impact

## Recommended Approach

Combine Options A + C + D:

1. **Pause pong timeout** when sending reconnect CONNECTION_ACK
2. **Check lastPongTime** before triggering reconnect
3. **Limit to 3 reconnect attempts** per session

## Open Questions

1. **What's the typical LiveKit reconnection time?**
   - Need to measure to set appropriate pong timeout pause duration
   - Estimate: 5-15 seconds for healthy network

2. **Should we track reconnect success rate?**
   - Add telemetry: did audio resume within X seconds of reconnect?
   - Would help tune thresholds

3. **Is the client handling CONNECTION_ACK correctly?**
   - Client might be doing full disconnect/reconnect instead of graceful reconnect
   - May need client-side investigation

## Conclusion

**The audio gap detection feature is NOT the root cause of widespread pong timeouts.** Pong timeouts are a pre-existing problem affecting many users on production where our feature isn't even deployed.

However, **our reconnect mechanism CAN trigger a death spiral in certain conditions** (observed in 1 out of 2 staging users). The fix should focus on preventing this edge case while keeping the feature's benefits for users like `haran_gopal@yahoo.com` where it's working correctly.

## Status

- [x] Problem identified and documented
- [x] Log analysis completed
- [ ] Decide on fix approach (Option A+C+D recommended)
- [ ] Implement fix
- [ ] Test on staging
- [ ] Deploy to production

## Related Issues

- 006-captions-and-apps-stopping (parent issue)
- 018-audio-gap-detection-auto-reconnect (introduced the reconnect mechanism)
- 003-livekit-mobile-reconnection-bug (original LiveKit reconnection investigation)

## Files Involved

- `cloud/packages/cloud/src/services/session/AudioManager.ts` - Audio gap detection
- `cloud/packages/cloud/src/services/session/UserSession.ts` - Pong timeout logic
- `mobile/` - Client-side CONNECTION_ACK handling (needs investigation)
