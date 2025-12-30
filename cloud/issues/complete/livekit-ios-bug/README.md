# LiveKit iOS Region Switching Bug

**Status:** 🔍 Investigation  
**Priority:** High  
**Affects:** iOS mobile clients using LiveKit audio transport  
**Date Created:** 2025-10-17

---

## 🚀 Quick Start: Better Stack Logging Setup

**NEW:** We've added Better Stack HTTP logging to capture Go bridge logs! This is critical for debugging the token expiration issue.

### 5-Minute Setup

1. **Create Better Stack HTTP Source** at https://telemetry.betterstack.com/
   - Platform: HTTP
   - Name: "LiveKit gRPC Bridge"
   - Save the token and ingesting host

2. **Test the connection:**

   ```bash
   cd cloud/packages/cloud-livekit-bridge
   export BETTERSTACK_SOURCE_TOKEN="your_token"
   export BETTERSTACK_INGESTING_HOST="your_host"
   ./test-betterstack.sh
   ```

3. **Add to `.env` and update `docker-compose.dev.yml`**

4. **Update Go code** - See [QUICK-START.md](../../packages/cloud-livekit-bridge/QUICK-START.md)

### 📚 Documentation

- **Quick Start**: [cloud/packages/cloud-livekit-bridge/QUICK-START.md](../../packages/cloud-livekit-bridge/QUICK-START.md)
- **Full Setup**: [cloud/packages/cloud-livekit-bridge/BETTERSTACK_SETUP.md](../../packages/cloud-livekit-bridge/BETTERSTACK_SETUP.md)
- **Token Analysis**: [TOKEN-EXPIRATION-ANALYSIS.md](./TOKEN-EXPIRATION-ANALYSIS.md)

### Why This Matters

The token expiration errors we're seeing in the logs:

```
"error"="invalid token: ..., error: token is expired (exp)"
```

Are now searchable in Better Stack:

```
service:livekit-bridge AND error:*token is expired*
service:livekit-bridge AND user_id:"isaiah@mentra.glass"
```

---

## Problem Description

When an iOS mobile client switches between cloud regions (e.g., `cloud-debug` in `centralus` → `cloud-livekit` or `france`), LiveKit audio completely breaks. The initial connection works fine, but switching regions causes the LiveKit connection to fail.

**Key observation:** Each region is a separate cloud instance with its own UserSession. Regions don't communicate with each other.

---

## Flow Analysis

### 1. How Mobile Gets LiveKit URL

**File:** `mobile/src/managers/SocketComms.ts`

```typescript
private handle_connection_ack(msg: any) {
  console.log("SocketCommsTS: connection ack, connecting to livekit")
  livekitManager.connect()
  GlobalEventEmitter.emit("APP_STATE_CHANGE", msg)
}
```

**File:** `mobile/src/managers/LivekitManager.ts`

```typescript
public async connect() {
  try {
    const {url, token} = await restComms.getLivekitUrlAndToken()
    console.log(`LivekitManager: Connecting to room: ${url}, ${token}`)
    this.room = new Room()
    await this.room.connect(url, token)
    // ...
  }
}
```

**File:** `mobile/src/managers/RestComms.tsx`

```typescript
public async getLivekitUrlAndToken(): Promise<{url: string; token: string}> {
  const response = await this.authenticatedRequest("GET", "/api/client/livekit/token")
  const {url, token} = response.data
  return {url, token}
}
```

**Steps:**

1. Mobile connects to cloud WebSocket (glasses-ws)
2. Cloud sends `CONNECTION_ACK` message
3. Mobile's `SocketComms` receives `CONNECTION_ACK`, calls `livekitManager.connect()`
4. `LivekitManager.connect()` calls `restComms.getLivekitUrlAndToken()`
5. REST API call to `/api/client/livekit/token` on the cloud server
6. Cloud returns `{url, token}` from its environment variables
7. Mobile connects to LiveKit using that URL and token

### 2. How Cloud Sends LiveKit Info

**File:** `cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts`

```typescript
private async handleConnectionInit(
  userSession: UserSession,
  reconnection: boolean,
  livekitRequested = false,
): Promise<void> {
  // ... start apps ...

  const ackMessage: ConnectionAck = {
    type: CloudToGlassesMessageType.CONNECTION_ACK,
    sessionId: userSession.sessionId,
    timestamp: new Date(),
  };

  if (livekitRequested) {
    try {
      const livekitInfo = await userSession.liveKitManager.handleLiveKitInit();
      if (livekitInfo) {
        (ackMessage as any).livekit = {
          url: livekitInfo.url,
          roomName: livekitInfo.roomName,
          token: livekitInfo.token,
        };
      }
    } catch (error) {
      // ...
    }
  }

  userSession.websocket.send(JSON.stringify(ackMessage));
}
```

**File:** `cloud/packages/cloud/src/services/session/livekit/LiveKitManager.ts`

```typescript
constructor(session: UserSession) {
  this.apiKey = process.env.LIVEKIT_API_KEY || "";
  this.apiSecret = process.env.LIVEKIT_API_SECRET || "";
  this.livekitUrl = process.env.LIVEKIT_URL || "";
  // ...
}

async handleLiveKitInit(): Promise<{
  url: string;
  roomName: string;
  token: string;
} | null> {
  const url = this.getUrl();  // Returns process.env.LIVEKIT_URL
  const roomName = this.getRoomName();  // Returns userId
  const token = await this.mintClientPublishToken();

  if (!url || !roomName || !token) {
    return null;
  }

  await this.startBridgeSubscriber({ url, roomName });
  return { url, roomName, token };
}
```

**Environment Variables (per region):**

- `LIVEKIT_URL` - LiveKit WebSocket URL
- `LIVEKIT_API_KEY` - LiveKit API key
- `LIVEKIT_API_SECRET` - LiveKit API secret

### 3. How gRPC Bridge Connects

**File:** `cloud/packages/cloud/src/services/session/livekit/LiveKitGrpcClient.ts`

```typescript
constructor(userSession: UserSession, bridgeUrl?: string) {
  const socketPath = process.env.LIVEKIT_GRPC_SOCKET;
  if (socketPath) {
    this.bridgeUrl = `unix:${socketPath}`;
  } else {
    this.bridgeUrl =
      bridgeUrl ||
      process.env.LIVEKIT_GRPC_BRIDGE_URL ||
      "livekit-bridge:9090";
  }
}
```

**Environment Variables:**

- `LIVEKIT_GRPC_BRIDGE_URL` - URL to Go gRPC bridge (e.g., `livekit-bridge:9090`)
- `LIVEKIT_GRPC_SOCKET` - Unix socket path (alternative to TCP)

---

## Hypotheses

### Hypothesis 1: Mobile Doesn't Disconnect from Old LiveKit Session

**Problem:** When switching regions, mobile might:

- Not disconnect from old LiveKit room
- Keep sending audio to old region's LiveKit
- Try to connect to new region's LiveKit while still connected to old

**Evidence Needed:**

- Mobile logs showing LiveKit disconnect/reconnect
- Check if `livekitManager.disconnect()` is called before `connect()`

**Files to Check:**

- `mobile/src/managers/LivekitManager.ts` - Does it have disconnect logic?
- `mobile/src/managers/WebSocketManager.ts` - Does it clean up LiveKit on region switch?

### Hypothesis 2: Different Regions Point to Different LiveKit Instances

**Problem:** Each region might have:

- Different `LIVEKIT_URL` environment variable
- Pointing to different LiveKit cloud instances
- But using the same `roomName` (userId)

**Result:** User tries to join room on different LiveKit instance, but mobile is still connected to old instance.

**Evidence Needed:**

- Check `LIVEKIT_URL` for each region:
  - `cloud-debug` (centralus)
  - `cloud-livekit` (centralus)
  - `france` region
- Are they the same LiveKit instance or different?

**How to Check:**

```bash
# Get env vars for each deployment
kubectl exec -n default cloud-debug-cloud-XXX -- env | grep LIVEKIT
kubectl exec -n default cloud-livekit-cloud-XXX -- env | grep LIVEKIT
```

### Hypothesis 3: Token Mismatch or Expired Token

**Problem:** Mobile gets token from old region, tries to use it with new region's LiveKit info.

**Evidence Needed:**

- Check if token is region-specific
- Check token TTL (currently 300 seconds / 5 minutes)
- Mobile logs showing token errors

### Hypothesis 4: gRPC Bridge Conflict

**Problem:** Both regions' gRPC bridges might be trying to:

- Join the same LiveKit room (roomName = userId)
- Publish/subscribe to same audio streams
- Causing conflicts

**Evidence Needed:**

- Check if old region's gRPC bridge properly disconnects
- Check Go bridge logs for conflicts
- Check if `UserSession.dispose()` properly cleans up LiveKit

**Files:**

- `cloud/packages/cloud/src/services/session/UserSession.ts` (line 596-687: dispose method)
- `cloud/packages/cloud/src/services/session/livekit/LiveKitManager.ts` (line 312-323: dispose method)
- `cloud/packages/cloud/src/services/session/livekit/LiveKitGrpcClient.ts` (line 765-775: dispose/disconnect)

### Hypothesis 5: REST API Caching or Wrong URL

**Problem:** Mobile might be:

- Caching old region's REST API URL
- Calling `/api/client/livekit/token` on old region instead of new region
- Getting stale LiveKit URL

**Evidence Needed:**

- Check if `RestComms` base URL updates when switching regions
- Check if mobile properly updates API endpoint on region switch

**Files:**

- `mobile/src/managers/RestComms.tsx` - Check if `baseUrl` updates on region change

---

## Required Information to Debug

### From Mobile (iOS)

1. **Logs during region switch:**

   ```
   - "LivekitManager: Connecting to room: ${url}, ${token}"
   - "LivekitManager: Connected to room"
   - "LivekitManager: Disconnected from room"
   ```

2. **Check if disconnect is called:**
   - Does `LivekitManager` have a `disconnect()` method?
   - Is it called before switching regions?

3. **API endpoint used:**
   - What URL is `restComms.getLivekitUrlAndToken()` calling?
   - Is it the old region or new region?

### From Cloud (Both Regions)

1. **Environment variables:**

   ```bash
   # For each region
   echo $LIVEKIT_URL
   echo $LIVEKIT_API_KEY
   echo $LIVEKIT_GRPC_BRIDGE_URL
   ```

2. **Logs from old region (when user switches away):**
   - Does UserSession dispose?
   - Does LiveKitManager dispose?
   - Does gRPC bridge disconnect from LiveKit room?

3. **Logs from new region (when user switches to it):**
   - Does CONNECTION_ACK include LiveKit info?
   - Does gRPC bridge successfully join LiveKit room?

### From Go Bridge

**🚨 CRITICAL FINDING: Go bridge logs are NOT being captured!**

1. **Problem discovered:**
   - The `start.sh` script runs Go bridge in background: `./livekit-bridge &`
   - stdout/stderr from Go process is NOT being redirected
   - `kubectl logs` only shows TypeScript/Bun logs
   - Go bridge errors are invisible!

2. **Evidence:**
   - File: `/app/start.sh` in pod
   - Line 22: `./livekit-bridge &` (no output redirection)
   - Line 51: `cd packages/cloud && PORT=80 bun run start &`
   - Only Bun process logs are captured

3. **How to see bridge startup (container level):**

   ```bash
   # The start.sh shows these echo statements at startup:
   # "🚀 Starting Go LiveKit gRPC bridge on Unix socket: /tmp/livekit-bridge.sock"
   # "✅ Unix socket created successfully"
   # "☁️ Starting Bun cloud service on :80..."
   # BUT the actual Go bridge logs after startup are lost!
   ```

4. **This means:**
   - We can't see gRPC errors
   - We can't see LiveKit room join/leave events
   - We can't see connection conflicts
   - We can't debug the actual bug without fixing logging first!

5. **TypeScript side shows bridge is "connected":**
   ```
   "Bridge health" logs every 10 seconds showing:
   - isConnected: true
   - userId: "isaiah@mentra.glass"
   ```
   But we don't know what the Go bridge is actually doing!

---

## Reproduction Steps

1. Start with iOS client connected to `cloud-debug` (centralus) with LiveKit enabled
2. Verify audio is working (microphone on, transcription working)
3. Switch regions in mobile app settings
4. Connect to different region (`cloud-livekit` or `france`)
5. **Expected:** LiveKit audio continues working
6. **Actual:** LiveKit audio breaks

---

## Files Involved

### Cloud (TypeScript)

1. **WebSocket Connection:**
   - `cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts`
     - Line 571-650: `handleConnectionInit()` - sends CONNECTION_ACK with LiveKit info

2. **LiveKit Manager:**
   - `cloud/packages/cloud/src/services/session/livekit/LiveKitManager.ts`
     - Line 20-45: constructor - loads env vars
     - Line 90-120: `handleLiveKitInit()` - returns LiveKit connection info
     - Line 312-323: `dispose()` - cleanup

3. **gRPC Bridge Client:**
   - `cloud/packages/cloud/src/services/session/livekit/LiveKitGrpcClient.ts`
     - Line 55-80: constructor - loads bridge URL
     - Line 200-350: `connect()` and `JoinRoom()`
     - Line 712-763: `disconnect()` - leaves LiveKit room
     - Line 765-775: `dispose()` - cleanup

4. **UserSession:**
   - `cloud/packages/cloud/src/services/session/UserSession.ts`
     - Line 596-687: `dispose()` - calls `liveKitManager.dispose()`

5. **REST API:**
   - `cloud/packages/cloud/src/api/client/livekit.api.ts` (likely location)
     - Endpoint: `GET /api/client/livekit/token`

### Mobile (TypeScript/React Native)

1. **LiveKit Manager:**
   - `mobile/src/managers/LivekitManager.ts`
     - Line 35-48: `connect()` - connects to LiveKit
     - Need to check: `disconnect()` method

2. **Socket Communications:**
   - `mobile/src/managers/SocketComms.ts`
     - Line 305-311: `handle_connection_ack()` - triggers LiveKit connect

3. **REST Communications:**
   - `mobile/src/managers/RestComms.tsx`
     - Line 291-295: `getLivekitUrlAndToken()` - fetches from cloud

4. **WebSocket Manager:**
   - `mobile/src/managers/WebSocketManager.ts`
     - Need to check: cleanup on region switch

### Go Bridge

1. **gRPC Bridge Service:**
   - `cloud/packages/cloud-livekit-bridge/service.go`
   - `cloud/packages/cloud-livekit-bridge/session.go`
   - Need to check: room join/leave logic

---

## Next Steps

1. **Add mobile logging:**
   - Log when `livekitManager.connect()` is called
   - Log when `livekitManager.disconnect()` is called (if exists)
   - Log the URL and token being used
   - Log the REST API URL being called

2. **Add cloud logging:**
   - Log `LIVEKIT_URL` on each region when `handleLiveKitInit()` is called
   - Log when `LiveKitManager.dispose()` is called
   - Log when `LiveKitGrpcClient.disconnect()` is called

3. **Check environment variables:**
   - Verify `LIVEKIT_URL` for each region
   - Verify they point to the same or different LiveKit instances

4. **Check Go bridge logs:**
   - Find bridge container/sidecar
   - Check for room join/leave events
   - Check for conflicts or errors

5. **Test with explicit disconnect:**
   - Add `livekitManager.disconnect()` in mobile before connecting to new region
   - See if that fixes the issue

---

## Potential Fixes

### Fix 1: Ensure Mobile Disconnects Before Reconnecting

```typescript
// mobile/src/managers/LivekitManager.ts
public async connect() {
  // Disconnect from old session first
  if (this.room && this.room.state === ConnectionState.Connected) {
    console.log("LivekitManager: Disconnecting from old room before reconnecting")
    await this.room.disconnect()
  }

  // Then connect to new room
  const {url, token} = await restComms.getLivekitUrlAndToken()
  // ...
}
```

### Fix 2: Clean Up Old Region's LiveKit Connection Immediately

```typescript
// cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts
private handleGlassesConnectionClose(...) {
  // BEFORE entering grace period, immediately clean up LiveKit
  if (userSession.liveKitManager) {
    logger.info("Immediately disposing LiveKit due to glasses disconnect")
    userSession.liveKitManager.dispose()
  }

  // Then handle grace period...
}
```

### Fix 3: Use Region-Specific Room Names

```typescript
// cloud/packages/cloud/src/services/session/livekit/LiveKitManager.ts
getRoomName(): string {
  const region = process.env.REGION || "unknown"
  return `${this.session.userId}-${region}`  // e.g., "user@email.com-centralus"
}
```

This would prevent room conflicts between regions, but might be overkill.

---

## Testing Plan

1. Connect to region A with LiveKit
2. Verify audio works
3. Add logging to mobile and cloud
4. Switch to region B
5. Capture logs from:
   - Mobile console
   - Region A cloud logs
   - Region B cloud logs
   - Go bridge logs (both regions)
6. Analyze logs to identify exact failure point
7. Implement fix
8. Repeat test to verify fix

---

## ✅ RESOLVED: Go Bridge Logging

**UPDATE:** We've implemented Better Stack HTTP logging for the Go bridge!

Instead of fixing `start.sh` to redirect stdout/stderr, we've implemented a proper logging solution:

### What We Added

1. **Better Stack HTTP Logger** (`cloud/packages/cloud-livekit-bridge/logger/betterstack.go`)
   - Sends logs directly to Better Stack via HTTP
   - Batch processing for efficiency
   - Structured logging with user_id, session_id, room_name
   - Auto-flush every 5 seconds

2. **Integration in Go Code**
   - Logger initialized in `main.go`
   - Used throughout `service.go` for all events
   - Captures errors, warnings, and info logs

3. **Test Script** (`test-betterstack.sh`)
   - Verify logging works before deployment
   - Tests single logs, batches, and complex log entries

### Benefits Over stdout/stderr Redirection

✅ **Structured logs** - JSON with fields for filtering  
✅ **Searchable** - Query by user_id, session_id, error type  
✅ **Centralized** - Logs from all regions in one place  
✅ **Reliable** - No dependency on kubectl/container logs  
✅ **Real-time** - Immediate visibility in Better Stack

### Setup Instructions

See [QUICK-START.md](../../packages/cloud-livekit-bridge/QUICK-START.md) for 5-minute setup guide.

---

## Related Files

- Design docs: `cloud/issues/livekit-grpc/`
- LiveKit gRPC implementation: `cloud/packages/cloud-livekit-bridge/`
- Mobile LiveKit integration: `mobile/src/managers/LivekitManager.ts`
- **Startup script with logging issue:** `cloud/start.sh` (line 22)
