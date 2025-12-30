# LiveKit Token Expiration Analysis

## Problem Summary

The LiveKit bridge is showing token expiration errors when attempting to reconnect:

```
livekit-bridge-1  | 2025/10/17 22:32:27 "msg"="error establishing signal connection"
"error"="websocket: bad handshake" "duration"="145.39925ms" "status"=401
"response"="invalid token: eyJhbGci..., error: go-jose/go-jose/jwt: validation failed,
token is expired (exp)"
```

## Token Analysis

### Decoded Token Claims

```json
{
  "exp": 1760739548,
  "identity": "cloud-agent:isaiah@mentra.glass",
  "iss": "APIHxBuhqxPzR66",
  "kind": "standard",
  "nbf": 1760738948,
  "sub": "cloud-agent:isaiah@mentra.glass",
  "video": {
    "canPublish": true,
    "canPublishData": true,
    "canSubscribe": true,
    "room": "isaiah@mentra.glass",
    "roomJoin": true
  }
}
```

### Token Lifetime

- **NBF (Not Before)**: 1760738948 (October 17, 2025, 22:22:28 UTC)
- **EXP (Expiration)**: 1760739548 (October 17, 2025, 22:32:28 UTC)
- **Lifetime**: 600 seconds (10 minutes)

### Connection Attempt

- **Attempt Time**: 2025/10/17 22:32:27
- **Token Expiration**: October 17, 2025, 22:32:28 UTC
- **Issue**: Token was about to expire (1 second remaining)

## Root Causes

### 1. Token Reuse After Expiration

The bridge is trying to reconnect with an expired token. This suggests:

- Token was generated 10 minutes ago
- Connection was lost or interrupted
- Bridge is attempting automatic reconnection with the old token
- No token refresh mechanism exists

### 2. Reconnection Logic Issue

The log shows:

```
"level"=0 "msg"="resuming connection..." "reconnectCount"=4
```

This indicates:

- 4 reconnection attempts have been made
- Each attempt is using the same expired token
- No token refresh happens between reconnection attempts

### 3. Region Switch Scenario

When switching regions (e.g., centralus → france):

1. **Old region connection**: May still be active with old token
2. **New region connection**: Attempts to establish with new credentials
3. **Old connection cleanup**: May not be disposing properly
4. **Token conflict**: Old token may be reused for new connection

## Why This Happens

### Token Generation Flow

1. **Client requests LiveKit access**
   - Cloud generates token with 10-minute expiration
   - Token includes room name, user identity, permissions

2. **Token sent to bridge**
   - Bridge receives token via gRPC
   - Bridge connects to LiveKit room using token

3. **Connection interruption**
   - Network hiccup, region switch, or session change
   - Bridge attempts automatic reconnection

4. **Reconnection with stale token**
   - Bridge reuses the original token
   - Token has expired (10 minutes passed)
   - LiveKit rejects with 401 Unauthorized

### LiveKit SDK Behavior

The LiveKit Go SDK has built-in reconnection logic:

- Automatically attempts to reconnect on connection loss
- Default reconnection attempts: multiple retries with backoff
- **Does NOT automatically refresh tokens**
- Expects application to handle token refresh

## Solutions

### Solution 1: Token Refresh Callback

Implement token refresh in the bridge service:

```go
// In service.go
func (s *LiveKitBridgeService) JoinRoom(req *pb.JoinRoomRequest, stream pb.LiveKitBridge_JoinRoomServer) error {
    // Create room with token refresh callback
    roomCallback := &lksdk.RoomCallback{
        OnReconnecting: func() {
            log.Println("Reconnecting to room...")
        },
        OnReconnected: func() {
            log.Println("Successfully reconnected to room")
        },
        OnDisconnected: func() {
            log.Println("Disconnected from room")
        },
    }

    // Set up token refresh
    room.OnTokenRefresh = func() (string, error) {
        // Request new token from cloud service
        newToken, err := s.requestNewToken(req.UserId, req.RoomName, req.SessionId)
        if err != nil {
            return "", fmt.Errorf("failed to refresh token: %w", err)
        }
        log.Printf("Token refreshed for user %s", req.UserId)
        return newToken, nil
    }

    room, err := lksdk.ConnectToRoom(req.LivekitUrl, lksdk.ConnectInfo{
        APIKey:              req.ApiKey,
        APISecret:           req.ApiSecret,
        RoomName:            req.RoomName,
        ParticipantIdentity: participantIdentity,
    }, roomCallback)
}
```

### Solution 2: Proactive Token Refresh

Refresh tokens before they expire:

```go
// Start token refresh goroutine
go func() {
    ticker := time.NewTicker(8 * time.Minute) // Refresh before 10-min expiry
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            newToken, err := s.requestNewToken(req.UserId, req.RoomName, req.SessionId)
            if err != nil {
                log.Printf("Failed to proactively refresh token: %v", err)
                continue
            }
            // Update room connection with new token
            room.UpdateToken(newToken)
            log.Printf("Proactively refreshed token for user %s", req.UserId)
        case <-ctx.Done():
            return
        }
    }
}()
```

### Solution 3: Increase Token Lifetime

Temporary workaround - increase token expiration time:

```typescript
// In cloud service (TypeScript)
const token = new AccessToken(apiKey, apiSecret, {
  identity: participantIdentity,
  ttl: "1h", // Increase from 10 minutes to 1 hour
});
```

**Trade-off**: Less secure, but reduces frequency of expiration issues.

### Solution 4: Graceful Disconnect on Region Switch

Ensure old connections are properly closed:

```go
// When region switch detected
func (s *LiveKitBridgeService) onRegionSwitch(userId, sessionId string) {
    s.roomsMu.Lock()
    defer s.roomsMu.Unlock()

    // Find and close old connection
    for key, conn := range s.rooms {
        if conn.userId == userId && conn.sessionId != sessionId {
            log.Printf("Closing old connection for user %s (old session: %s)", userId, conn.sessionId)
            conn.room.Disconnect()
            delete(s.rooms, key)
        }
    }
}
```

## Recommended Implementation Order

1. **Immediate (Quick Fix)**
   - ✅ Set up Better Stack logging (see BETTERSTACK_SETUP.md)
   - ✅ Increase token TTL to 1 hour temporarily
   - ✅ Add explicit disconnect on region switch

2. **Short-term (Proper Fix)**
   - Implement token refresh callback in bridge
   - Add token refresh gRPC method to bridge proto
   - Cloud service provides token refresh endpoint
   - Bridge requests new token when needed

3. **Long-term (Robust Solution)**
   - Implement proactive token refresh
   - Add token expiration monitoring
   - Set up alerts for token refresh failures
   - Add metrics for connection lifetime vs token lifetime

## Testing Plan

### Test 1: Token Expiration

1. Set token TTL to 30 seconds
2. Connect to LiveKit
3. Wait 35 seconds
4. Verify connection stays alive (token was refreshed)

### Test 2: Region Switch

1. Connect to cloud-debug (centralus)
2. Enable microphone/audio
3. Switch to cloud-livekit (france)
4. Verify:
   - Old connection closes cleanly
   - New connection establishes successfully
   - No token expiration errors

### Test 3: Network Interruption

1. Connect to LiveKit
2. Simulate network drop (disable WiFi briefly)
3. Restore network
4. Verify automatic reconnection with token refresh

## Related Files

- `cloud/packages/cloud-livekit-bridge/service.go` - Bridge service implementation
- `cloud/packages/cloud-livekit-bridge/proto/livekit_bridge.proto` - gRPC definitions
- `cloud/packages/cloud/src/services/livekit.service.ts` - Token generation
- `cloud/packages/cloud/src/services/websocket.service.ts` - Session management

## References

- [LiveKit Token Authentication](https://docs.livekit.io/realtime/concepts/authentication/)
- [LiveKit Go SDK - Room](https://pkg.go.dev/github.com/livekit/server-sdk-go/v2@v2.10.0#Room)
- [JWT Token Expiration Best Practices](https://auth0.com/docs/secure/tokens/json-web-tokens/json-web-token-claims)
