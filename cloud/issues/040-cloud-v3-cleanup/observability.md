# Cloud v3 — Observability

> **Status**: Draft
> **Date**: 2025-07-17
> **Related**: [overview.md](./overview.md) · [039-sdk-v3-api-surface](../039-sdk-v3-api-surface/v2-v3-api-map.md)

## What is this doc?

This doc covers how to make the MentraOS system observable — how to see what's happening, detect when something is broken, and quickly identify which layer of the stack the issue originates from.

## Why it matters

When something breaks in MentraOS, the investigation is slow and often misdirected. The cloud has structured logging in BetterStack, but the mobile client, ASG client, and glasses firmware don't ship their logs anywhere accessible. So debugging starts and ends with cloud logs, even when the issue is in a completely different layer — BLE disconnects, mobile app state, firmware rendering. Without visibility into the full stack, every issue looks like a cloud issue.

We need to answer three questions quickly:

1. **Is it working?** (yes/no — system-wide and per-session)
2. **What is broken?** (which pipeline, which layer)
3. **Why is it broken?** (root cause — what happened leading up to the failure)

## System context

See [overview.md](./overview.md) for full system architecture. The key challenge for observability is that the system spans 5 layers, each with its own logging:

```
Glasses (firmware)  ←BLE→  Mobile Client  ←WebSocket→  Cloud  ←HTTP→  Mini Apps
                              ↕
                         ASG Client
```

Currently only the cloud has centralized, searchable logs (BetterStack). The other layers log locally on-device with no way to access them remotely.

---

## Mental Model: Pipelines

Instead of thinking about individual components, think about **pipelines** — each is either flowing or broken:

| Pipeline            | What it means                        | Cloud already has the signal?                               |
| ------------------- | ------------------------------------ | ----------------------------------------------------------- |
| **Connection**      | Glasses ↔ Mobile ↔ Cloud connected | ✅ WebSocket state on `UserSession`                         |
| **Audio in**        | Mic audio is arriving at cloud       | ✅ Audio chunk timestamps on `MicrophoneManager`            |
| **Transcription**   | Audio → text is working              | ✅ Transcription event timestamps on `TranscriptionManager` |
| **Display out**     | Cloud sent content to glasses        | ✅ Display request timestamps on `DisplayManager`           |
| **App: \<name\>**   | Mini app is reachable and responding | ✅ Webhook response codes + timeouts on `AppManager`        |
| **BLE (last mile)** | Mobile ↔ Glasses link is healthy    | ❌ Cloud can't see this — needs client reporting            |

**The cloud already has ~80% of the signals.** It just doesn't aggregate them into something readable.

---

## Failure Modes & Attribution

Each pipeline has specific failure modes. The key: **the cloud can already distinguish most of them.**

### Connection broken

- WebSocket disconnected, or no activity for X seconds
- **Means**: User isn't connected at all
- **Layer**: Network, mobile app, or phone went to sleep
- **Cloud signal**: `UserSession.websocket` state

### Audio in broken

- Transcription stream is active but no audio chunks received for >5 seconds
- **Means**: Glasses/mobile aren't sending audio — BLE or mic issue
- **Layer**: Glasses mic, BLE link, or mobile audio forwarding — not cloud
- **Cloud signal**: Gap in audio chunk arrival timestamps

### Transcription broken

- Audio chunks ARE arriving but no transcription results for >10 seconds
- **Means**: Soniox stream died, rate limited, or cloud transcription pipeline broken
- **Layer**: Cloud / transcription provider
- **Cloud signal**: Audio arriving + no transcription output = cloud-side issue

### Display out broken

- Cloud is sending display requests but user reports nothing on screen
- **Means**: Mobile didn't forward to glasses, or BLE display channel broken
- **Layer**: Without client reporting, cloud can only say "I sent it." With client reporting, cloud can pinpoint which side of the mobile client the issue is on.
- **Cloud signal**: Display request sent timestamps. Client health reports (if implemented).

### App broken

- Webhook returns 5xx, times out, or connection refused
- **Means**: The mini app server is down or slow
- **Layer**: The third-party mini app — not cloud
- **Cloud signal**: Webhook response codes and latency per `packageName`

### BLE / last mile broken

- Cloud is sending, mobile is receiving, but glasses aren't getting updates
- **Means**: BLE link between phone and glasses is degraded or disconnected
- **Layer**: BLE / firmware / hardware
- **Cloud signal**: None currently — **requires client-side health reporting**

---

## What to Build

### 1. Per-Session Health Tracker

A lightweight object on `UserSession` that tracks "when did each pipeline last show signs of life?"

```typescript
// On UserSession
interface PipelineHealth {
  status: "ok" | "degraded" | "broken"
  lastOk: Date
  error?: string
}

interface SessionHealth {
  connection: PipelineHealth
  audioIn: PipelineHealth
  transcription: PipelineHealth
  displayOut: PipelineHealth
  apps: Record<string, PipelineHealth> // keyed by packageName

  // Client-reported (null if client doesn't support it yet)
  ble?: PipelineHealth | null
}

// Status derived from lastOk:
//   lastOk < 5s ago   → 'ok'
//   lastOk 5-30s ago  → 'degraded'
//   lastOk > 30s ago  → 'broken'
//   (thresholds tunable per pipeline)
```

The managers already have this data. They just need to update the health tracker when events happen:

| Event                         | Updates                                                  |
| ----------------------------- | -------------------------------------------------------- |
| Audio chunk received          | `audioIn.lastOk = now`                                   |
| Transcription result produced | `transcription.lastOk = now`                             |
| Display request sent          | `displayOut.lastOk = now`                                |
| Webhook 200 from mini app     | `apps[pkg].lastOk = now`                                 |
| Webhook 5xx / timeout         | `apps[pkg].status = 'broken'`, `apps[pkg].error = '502'` |
| WebSocket message received    | `connection.lastOk = now`                                |
| Client health ping received   | `ble.lastOk = now`, update BLE status                    |

This is near-zero overhead — just updating timestamps on existing code paths.

### 2. Health API Endpoints

```
GET /api/admin/session/:userId/health
```

Returns pipeline health for one session. When a user reports "it's broken," look here:

```json
{
  "userId": "user-xyz",
  "sessionAge": "12m",
  "pipelines": {
    "connection": {"status": "ok", "lastOk": "2s ago"},
    "audioIn": {"status": "ok", "lastOk": "1s ago"},
    "transcription": {"status": "broken", "lastOk": "45s ago", "error": "Soniox stream timeout"},
    "displayOut": {"status": "ok", "lastOk": "3s ago"},
    "apps": {
      "com.example.captions": {"status": "ok", "lastOk": "2s ago"},
      "com.example.translate": {"status": "broken", "lastOk": "3m ago", "error": "502 Bad Gateway"}
    },
    "ble": {"status": "ok", "lastOk": "8s ago"}
  }
}
```

Instantly tells you: transcription is broken (cloud/Soniox issue), translate app is down (not a cloud issue).

```
GET /api/admin/health/summary
```

System-wide overview:

```json
{
  "activeSessions": 142,
  "healthy": 138,
  "degraded": 3,
  "broken": 1,
  "byPipeline": {
    "connection": {"ok": 142, "degraded": 0, "broken": 0},
    "audioIn": {"ok": 140, "degraded": 2, "broken": 0},
    "transcription": {"ok": 139, "degraded": 2, "broken": 1},
    "displayOut": {"ok": 142, "degraded": 0, "broken": 0}
  },
  "appHealth": {
    "com.example.captions": {"ok": 95, "broken": 0},
    "com.example.translate": {"ok": 42, "broken": 3}
  }
}
```

### 3. Client-Side Health Reporting

The missing 20%. The mobile client sends periodic health pings over the existing WebSocket:

```typescript
// Mobile → Cloud (every 10-15 seconds)
{
  type: 'client_health',
  bleConnected: true,
  bleSignalStrength: -45,           // dBm, if available
  lastDisplayDelivered: '2025-07-17T15:32:01Z',  // last display update forwarded to glasses
  lastAudioChunkSent: '2025-07-17T15:32:02Z',    // last audio chunk forwarded from glasses
  mobileAppVersion: '2.4.1',
  glassesModel: 'g1',
  glassesFirmware: '1.2.3',        // if known
}
```

This lets the cloud distinguish:

- "I sent a display update, mobile says BLE is disconnected" → **glasses/BLE issue**
- "I sent a display update, mobile says BLE is fine, user still sees nothing" → **glasses firmware issue**
- "I sent a display update, mobile never reported receiving it" → **WebSocket/mobile issue**

### 4. On-Demand Client Log Collection

All client logs aren't shipped to the cloud all the time — that's too much volume, bandwidth, and battery drain for normal operation. Instead, clients log to a **local ring buffer** (last 5-10 minutes), and logs are collected on demand when investigating an issue.

#### How it works

**Normal operation:**

- Mobile client, ASG client, and glasses firmware all log locally to a rolling ring buffer (in-memory or small local file)
- Only the cloud logs go to BetterStack continuously
- No network overhead from client logging

**When investigating an issue:**

1. Someone triggers log collection — either:
   - User taps "Report Bug" in the app
   - Admin triggers it remotely via `POST /api/admin/session/:userId/collect-logs` (cloud sends a command to the mobile client over the WebSocket)
2. Mobile client collects its own log buffer + ASG client logs + glasses firmware logs (via BLE)
3. Client batches and ships them to BetterStack (or to cloud, which forwards to BetterStack)
4. All logs are tagged with `userId`, `sessionId`, and `source` (mobile/asg/firmware)

**Now you have everything:**

- Cloud logs (already in BetterStack, always available)
- Mobile client logs (collected on demand, covers the last 5-10 minutes)
- ASG client logs (collected on demand)
- Firmware logs (collected on demand via BLE → mobile → BetterStack)

All in one place, searchable by userId, showing the full timeline across all layers:

```
15:32:01 [cloud]    WebSocket connected for user-xyz
15:32:02 [mobile]   BLE connected to G1, firmware 1.2.3
15:32:03 [cloud]    Transcription stream started (Soniox)
15:32:05 [firmware] Mic capture started, sample rate 16kHz
15:32:06 [mobile]   Audio chunk forwarded to cloud (chunk #1)
15:32:07 [cloud]    Audio chunk received, forwarded to Soniox
15:32:10 [mobile]   BLE signal weak (-85 dBm)
15:32:12 [mobile]   BLE disconnected from G1
15:32:12 [cloud]    Audio chunks stopped arriving
15:32:15 [cloud]    Pipeline status: audioIn → broken
```

Full story, every layer, one search.

#### Log format

Consistent across all clients so logs are filterable in BetterStack:

```json
{
  "timestamp": "2025-07-17T15:32:12Z",
  "source": "mobile",
  "userId": "user-xyz",
  "sessionId": "session-abc",
  "level": "warn",
  "message": "BLE disconnected from G1",
  "context": {"signalStrength": -85, "disconnectReason": "timeout"}
}
```

#### Ring buffer considerations

- **Size**: 5-10 minutes of logs. Enough to capture the context around an issue if reported promptly.
- **Storage**: In-memory preferred (no disk I/O). Falls back to small rolling file for crash resilience.
- **Firmware**: Glasses are resource-constrained. They keep a minimal ring buffer and dump it to the mobile client over BLE on demand. This requires firmware team support.
- **Privacy**: No transcription text, no notification content, no auth tokens in logs. Only operational data (connection events, pipeline state, errors).

### 5. Structured Health Logging

When pipeline status changes (ok → degraded, degraded → broken, broken → ok), log it as a structured event:

```typescript
logger.warn(
  {
    event: "pipeline_status_change",
    userId: "user-xyz",
    pipeline: "transcription",
    from: "ok",
    to: "broken",
    lastOk: "45s ago",
    error: "Soniox stream timeout",
    sessionAge: "12m",
  },
  "Transcription pipeline broken for user-xyz",
)
```

These events go to BetterStack (already configured) and can be searched, filtered, and alerted on.

### 6. Alerting Rules

Simple threshold-based alerts:

| Rule                                                 | Threshold                 | Severity        |
| ---------------------------------------------------- | ------------------------- | --------------- |
| % of sessions with broken transcription              | > 5%                      | Critical        |
| Any mini app with > 50% webhook failure rate         | > 50% errors in 5 min     | Warning         |
| % of sessions with broken connection                 | > 10%                     | Critical        |
| Specific user session degraded for > 2 min           | Continuous degraded state | Info (log only) |
| System-wide: 0 active sessions during business hours | 0 sessions                | Critical        |

---

## Incident Investigation Playbook

When someone reports "it's broken":

**Step 1: Is it one user or system-wide?**

- Check `GET /api/admin/health/summary`
- If system-wide → cloud/provider issue, escalate immediately
- If one user → continue to step 2

**Step 2: What's broken for this user?**

- Check `GET /api/admin/session/:userId/health`
- Look at which pipeline is red/yellow

**Step 3: Identify the layer by pipeline:**

| Pipeline status                 | Likely layer           | Next step                                                             |
| ------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| Connection broken               | Mobile app / network   | Did mobile crash? Is phone on wifi? Check client health ping.         |
| Audio in broken                 | BLE / glasses mic      | Is BLE connected? (client health ping) Did glasses battery die?       |
| Transcription broken            | Cloud / Soniox         | Check Soniox status, check TranscriptionManager logs for this session |
| Display out broken + BLE ok     | Cloud display pipeline | Check DisplayManager logs for this session                            |
| Display out broken + BLE broken | BLE / glasses          | Mobile reports BLE disconnected — not a cloud issue                   |
| App: X broken                   | That mini app's server | Webhook returning errors — the mini app is down or slow               |

**Step 4: Collect client logs if needed**

- Trigger `POST /api/admin/session/:userId/collect-logs`
- Wait for client logs to arrive in BetterStack
- Search by `userId` to see the full cross-layer timeline

**Step 5: If still unclear**

- Search BetterStack logs by `userId` for the time window
- Look for `pipeline_status_change` events
- Look for error logs from the specific manager

---

## Implementation Priority

### Phase 1 — Quick wins (days, not weeks)

1. **Add `SessionHealth` to `UserSession`** — just timestamp tracking, near-zero overhead
2. **Update managers to set `lastOk` timestamps** — one line per event handler
3. **Build health API endpoints** — two admin endpoints, reads from in-memory state
4. **Add `pipeline_status_change` logging** — structured logs on status transitions

This alone gives you: per-session health view via API + searchable health events in BetterStack.

### Phase 2 — Client reporting

5. **Add `client_health` message type to WebSocket protocol** — mobile sends periodic pings
6. **Cloud parses and stores client health** — updates `ble` pipeline status
7. **Mobile team implements the ping** — simple periodic message, minimal code

This gives you: full last-mile visibility, can distinguish cloud vs BLE vs glasses issues.

### Phase 3 — On-demand log collection

8. **Implement ring buffer logging in mobile/ASG clients** — log to local rolling buffer
9. **Add collect-logs admin endpoint** — cloud sends command to client via WebSocket
10. **Client ships buffered logs to BetterStack** — tagged with userId/sessionId/source
11. **Firmware team adds minimal ring buffer** — dump to mobile on BLE request

This gives you: full cross-layer log timeline on demand, without continuous shipping overhead.

### Phase 4 — Alerting

12. **BetterStack alerts on `pipeline_status_change` events** — alert on `to: 'broken'` patterns
13. **Health summary dashboard** — either in admin UI or BetterStack dashboard

---

## Related docs

- [reliability.md](./reliability.md) — DisplayManager redesign, connection stability (overlaps with connection pipeline health)
- [testing.md](./testing.md) — cloud-bridge and e2e testing (the test harness can also validate pipeline health)
- [maintainability.md](./maintainability.md) — code cleanup that makes observability easier to implement

---

## Open Questions

| #   | Question                                                    | Notes                                                                                                   |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Q1  | Pipeline health thresholds — what's "degraded" vs "broken"? | 5s/30s proposed, needs tuning per pipeline. Transcription might have different thresholds than display. |
| Q2  | Client health ping interval?                                | 10-15s proposed. Too frequent = noise, too infrequent = stale data.                                     |
| Q3  | Health data retention                                       | In-memory only (current session)? Or persist to DB for historical analysis?                             |
| Q4  | Mobile team bandwidth                                       | Client-side health reporting + ring buffer logging requires mobile team work. What's their capacity?    |
| Q5  | Glasses telemetry                                           | Can the firmware keep a ring buffer and dump it over BLE? Or too constrained?                           |
| Q6  | Ring buffer size                                            | 5 minutes? 10 minutes? Depends on how quickly issues get reported.                                      |
| Q7  | BetterStack as aggregation point                            | Is BetterStack the right destination for client logs? Or do we need something else?                     |
