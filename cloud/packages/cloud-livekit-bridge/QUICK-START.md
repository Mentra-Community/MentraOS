# Quick Start: Better Stack Logging for LiveKit Bridge

This is a **5-minute setup** to get Go bridge logs into Better Stack so you can debug the token expiration issue.

## 🚀 Quick Setup (5 minutes)

### Step 1: Create Better Stack Source (2 min)

1. Go to https://telemetry.betterstack.com/
2. Click **Sources** → **New Source**
3. Select platform: **HTTP**
4. Name: `LiveKit gRPC Bridge`
5. Region: Choose your region (e.g., `us_east`)
6. Click **Create**

You'll get:

- **Source Token**: Copy this (looks like: `FczKcxEhjEDE58dBX7XaeX1q`)
- **Ingesting Host**: Copy this (looks like: `s123.us-east-1.betterstackdata.com`)

### Step 2: Test the Connection (1 min)

```bash
cd cloud/packages/cloud-livekit-bridge

# Export your credentials
export BETTERSTACK_SOURCE_TOKEN="YOUR_TOKEN_HERE"
export BETTERSTACK_INGESTING_HOST="YOUR_HOST_HERE"

# Run test script
./test-betterstack.sh
```

You should see:

```
✅ Single log sent successfully (HTTP 202)
✅ Batch logs sent successfully (HTTP 202)
✅ Complex log sent successfully (HTTP 202)
🎉 All tests passed!
```

### Step 3: Add to Your Environment (1 min)

Add to `cloud/.env`:

```bash
# Better Stack Configuration
BETTERSTACK_SOURCE_TOKEN=FczKcxEhjEDE58dBX7XaeX1q
BETTERSTACK_INGESTING_HOST=s123.us-east-1.betterstackdata.com
```

Update `cloud/docker-compose.dev.yml`:

```yaml
livekit-bridge:
  build:
    context: ./packages/cloud-livekit-bridge
    dockerfile: Dockerfile
  environment:
    - PORT=9090
    - LOG_LEVEL=debug
    - LIVEKIT_URL=${LIVEKIT_URL}
    - LIVEKIT_API_KEY=${LIVEKIT_API_KEY}
    - LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}
    - LIVEKIT_GRPC_SOCKET=/var/run/livekit/bridge.sock
    - BETTERSTACK_SOURCE_TOKEN=${BETTERSTACK_SOURCE_TOKEN} # ← Add this
    - BETTERSTACK_INGESTING_HOST=${BETTERSTACK_INGESTING_HOST} # ← Add this
  volumes:
    - livekit_socket:/var/run/livekit
  restart: "no"
```

### Step 4: Update Go Code (1 min)

**Update `main.go`:**

```go
package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/Mentra-Community/MentraOS/cloud/packages/cloud-livekit-bridge/logger"
	pb "github.com/Mentra-Community/MentraOS/cloud/packages/cloud-livekit-bridge/proto"
	// ... other imports
)

func main() {
	// Initialize Better Stack logger
	bsLogger := logger.NewFromEnv()
	defer bsLogger.Close()

	bsLogger.LogInfo("LiveKit gRPC Bridge starting", map[string]interface{}{
		"version": "1.0.0",
	})

	// ... rest of your main.go code

	// Pass logger to service
	lkService := NewLiveKitBridgeService(bsLogger)
	pb.RegisterLiveKitBridgeServer(grpcServer, lkService)

	// ... rest of setup
}
```

**Update `service.go`:**

```go
type LiveKitBridgeService struct {
	pb.UnimplementedLiveKitBridgeServer
	rooms    map[string]*RoomConnection
	roomsMu  sync.RWMutex
	bsLogger *logger.BetterStackLogger  // ← Add this
}

func NewLiveKitBridgeService(bsLogger *logger.BetterStackLogger) *LiveKitBridgeService {
	return &LiveKitBridgeService{
		rooms:    make(map[string]*RoomConnection),
		bsLogger: bsLogger,  // ← Add this
	}
}

func (s *LiveKitBridgeService) JoinRoom(req *pb.JoinRoomRequest, stream pb.LiveKitBridge_JoinRoomServer) error {
	s.bsLogger.LogInfo("JoinRoom request received", map[string]interface{}{
		"user_id":     req.UserId,
		"session_id":  req.SessionId,
		"room_name":   req.RoomName,
		"livekit_url": req.LivekitUrl,
	})

	// ... your existing code

	if err != nil {
		s.bsLogger.LogError("Failed to join room", err, map[string]interface{}{
			"user_id":   req.UserId,
			"room_name": req.RoomName,
		})
		return err
	}

	s.bsLogger.LogInfo("Successfully joined room", map[string]interface{}{
		"user_id":   req.UserId,
		"room_name": req.RoomName,
	})

	return nil
}
```

### Step 5: Restart and Test (1 min)

```bash
cd cloud

# Rebuild and restart
docker-compose -f docker-compose.dev.yml down
docker-compose -f docker-compose.dev.yml up --build livekit-bridge

# You should see:
# [BetterStack] Logger enabled, sending to s123.us-east-1.betterstackdata.com
```

## 🔍 Search Your Logs

Go to Better Stack → Your Source → Live Tail

Try these queries:

```
# All bridge logs
service:livekit-bridge

# Errors only
service:livekit-bridge AND level:error

# Token errors
service:livekit-bridge AND error:*token*

# Specific user
service:livekit-bridge AND user_id:"isaiah@mentra.glass"

# Region switch events
service:livekit-bridge AND message:*region*
```

## 🐛 Debugging Token Expiration

Now that logs are in Better Stack, you can trace the token expiration issue:

1. **Reproduce the issue:**

   ```bash
   # Switch from cloud-debug to cloud-livekit in mobile app
   ```

2. **Search for token errors:**

   ```
   service:livekit-bridge AND error:*expired*
   ```

3. **Find the connection sequence:**

   ```
   service:livekit-bridge AND user_id:"isaiah@mentra.glass"
   AND (message:*JoinRoom* OR error:*token*)
   ```

4. **Check timestamps:**
   - Look at when token was issued
   - Look at when connection failed
   - Calculate time difference (should be ~10 minutes)

## 📚 Full Documentation

For complete setup and advanced features:

- **Full Setup Guide**: [BETTERSTACK_SETUP.md](./BETTERSTACK_SETUP.md)
- **Token Analysis**: [../../../issues/livekit-ios-bug/TOKEN-EXPIRATION-ANALYSIS.md](../../../issues/livekit-ios-bug/TOKEN-EXPIRATION-ANALYSIS.md)
- **Debug Commands**: [../../../issues/livekit-ios-bug/DEBUG-COMMANDS.md](../../../issues/livekit-ios-bug/DEBUG-COMMANDS.md)

## ✅ Verification Checklist

- [ ] Better Stack source created
- [ ] Test script passes (all 3 tests)
- [ ] Environment variables added to `.env`
- [ ] Docker compose updated
- [ ] `main.go` updated with logger
- [ ] `service.go` updated with logger
- [ ] Container restarted
- [ ] See logs in Better Stack Live Tail
- [ ] Can search and filter logs

## 🆘 Troubleshooting

**Logs not appearing?**

```bash
# Check environment variables in container
docker-compose exec livekit-bridge env | grep BETTERSTACK

# Check container logs for Better Stack messages
docker-compose logs livekit-bridge | grep BetterStack
```

You should see:

```
[BetterStack] Logger enabled, sending to s123...
```

If you see:

```
[BetterStack] Logger disabled (missing BETTERSTACK_SOURCE_TOKEN or BETTERSTACK_INGESTING_HOST)
```

Then environment variables are not set correctly.

**HTTP 403 Forbidden?**

Your source token is invalid. Double-check the token from Better Stack.

**HTTP 413 Payload Too Large?**

Logs are too big. Reduce batch size in `logger/betterstack.go`:

```go
BatchSize: 5,  // Reduce from 10
```

## 🎯 Next Steps

1. ✅ Get logs flowing to Better Stack
2. 🔍 Reproduce token expiration issue
3. 📊 Analyze logs to confirm 10-minute token lifetime
4. 🛠️ Implement token refresh (see TOKEN-EXPIRATION-ANALYSIS.md)
5. ✅ Test region switching works without errors

---

**Questions?** Check the [full documentation](./BETTERSTACK_SETUP.md) or the [GitHub issues](https://github.com/Mentra-Community/MentraOS/issues).
