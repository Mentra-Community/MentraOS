# Better Stack Logging Setup for LiveKit Bridge

This guide explains how to set up Better Stack logging for the LiveKit gRPC bridge to capture and search logs from the Go service.

## Why Better Stack for Go Logs?

The LiveKit bridge logs are critical for debugging issues like:

- Token expiration errors
- Region switching problems
- Connection failures
- Room join/leave events

By sending these logs to Better Stack, you can:

- Search and filter logs in real-time
- Correlate Go bridge logs with TypeScript cloud logs
- Set up alerts for specific error patterns
- Debug production issues without SSH access

## Quick Setup

### Step 1: Create a Better Stack HTTP Source

1. Go to [Better Stack Telemetry](https://telemetry.betterstack.com/)
2. Navigate to **Sources** → **Create Source**
3. Choose platform: **HTTP**
4. Set name: **"LiveKit gRPC Bridge"**
5. Choose your data region (e.g., `us_east`, `germany`, etc.)
6. Click **Create Source**

You'll receive:

- **Source Token**: `YOUR_SOURCE_TOKEN`
- **Ingesting Host**: `sXXX.region.betterstackdata.com`

### Step 2: Add Environment Variables

Update your `.env` file or environment configuration:

```bash
# Better Stack Configuration
BETTERSTACK_SOURCE_TOKEN=YOUR_SOURCE_TOKEN
BETTERSTACK_INGESTING_HOST=sXXX.region.betterstackdata.com
```

### Step 3: Update Docker Compose

Add the environment variables to your `docker-compose.dev.yml`:

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
    - BETTERSTACK_SOURCE_TOKEN=${BETTERSTACK_SOURCE_TOKEN}
    - BETTERSTACK_INGESTING_HOST=${BETTERSTACK_INGESTING_HOST}
  volumes:
    - livekit_socket:/var/run/livekit
  restart: "no"
```

### Step 4: Integrate Logger in main.go

Update `main.go` to use the Better Stack logger:

```go
package main

import (
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/Mentra-Community/MentraOS/cloud/packages/cloud-livekit-bridge/logger"
	pb "github.com/Mentra-Community/MentraOS/cloud/packages/cloud-livekit-bridge/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
)

func main() {
	// Initialize Better Stack logger
	bsLogger := logger.NewFromEnv()
	defer bsLogger.Close()

	bsLogger.LogInfo("LiveKit gRPC Bridge starting", map[string]interface{}{
		"version": "1.0.0",
		"socket":  os.Getenv("LIVEKIT_GRPC_SOCKET"),
		"port":    os.Getenv("PORT"),
	})

	// Rest of your existing main.go code...
	socketPath := os.Getenv("LIVEKIT_GRPC_SOCKET")
	port := os.Getenv("PORT")

	var lis net.Listener
	var err error

	if socketPath != "" {
		// Unix socket mode
		socketDir := filepath.Dir(socketPath)
		if err := os.MkdirAll(socketDir, 0755); err != nil {
			bsLogger.LogError("Failed to create socket directory", err, nil)
			log.Fatalf("Failed to create socket directory: %v", err)
		}

		os.Remove(socketPath)
		lis, err = net.Listen("unix", socketPath)
		if err != nil {
			bsLogger.LogError("Failed to listen on Unix socket", err, map[string]interface{}{
				"socket_path": socketPath,
			})
			log.Fatalf("Failed to listen on Unix socket: %v", err)
		}

		if err := os.Chmod(socketPath, 0777); err != nil {
			bsLogger.LogError("Failed to set socket permissions", err, nil)
			log.Fatalf("Failed to set socket permissions: %v", err)
		}

		bsLogger.LogInfo("Server listening on Unix socket", map[string]interface{}{
			"socket_path": socketPath,
		})
		log.Printf("gRPC server listening on Unix socket: %s", socketPath)
	} else {
		// TCP mode
		if port == "" {
			port = "9090"
		}
		addr := fmt.Sprintf("0.0.0.0:%s", port)
		lis, err = net.Listen("tcp", addr)
		if err != nil {
			bsLogger.LogError("Failed to listen on TCP", err, map[string]interface{}{
				"address": addr,
			})
			log.Fatalf("Failed to listen: %v", err)
		}

		bsLogger.LogInfo("Server listening on TCP", map[string]interface{}{
			"address": addr,
		})
		log.Printf("gRPC server listening on: %s", addr)
	}

	// Create gRPC server with logger
	grpcServer := grpc.NewServer()
	lkService := NewLiveKitBridgeService(bsLogger)
	pb.RegisterLiveKitBridgeServer(grpcServer, lkService)

	// Health check
	healthServer := health.NewServer()
	healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)
	grpc_health_v1.RegisterHealthServer(grpcServer, healthServer)

	// Reflection
	reflection.Register(grpcServer)

	// Handle graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sigCh
		bsLogger.LogInfo("Received shutdown signal, gracefully stopping", nil)
		log.Println("Received shutdown signal, gracefully stopping...")
		grpcServer.GracefulStop()
	}()

	bsLogger.LogInfo("gRPC server started successfully", nil)
	if err := grpcServer.Serve(lis); err != nil {
		bsLogger.LogError("Server failed", err, nil)
		log.Fatalf("Failed to serve: %v", err)
	}
}
```

### Step 5: Update Service to Use Logger

Update `service.go` to accept and use the logger:

```go
type LiveKitBridgeService struct {
	pb.UnimplementedLiveKitBridgeServer
	rooms    map[string]*RoomConnection
	roomsMu  sync.RWMutex
	bsLogger *logger.BetterStackLogger
}

func NewLiveKitBridgeService(bsLogger *logger.BetterStackLogger) *LiveKitBridgeService {
	return &LiveKitBridgeService{
		rooms:    make(map[string]*RoomConnection),
		bsLogger: bsLogger,
	}
}

func (s *LiveKitBridgeService) JoinRoom(req *pb.JoinRoomRequest, stream pb.LiveKitBridge_JoinRoomServer) error {
	s.bsLogger.LogInfo("JoinRoom request received", map[string]interface{}{
		"user_id":     req.UserId,
		"session_id":  req.SessionId,
		"room_name":   req.RoomName,
		"livekit_url": req.LivekitUrl,
	})

	// Your existing JoinRoom logic...

	// Log errors with context
	if err != nil {
		s.bsLogger.LogError("Failed to join room", err, map[string]interface{}{
			"user_id":    req.UserId,
			"room_name":  req.RoomName,
			"session_id": req.SessionId,
		})
		return err
	}

	s.bsLogger.LogInfo("Successfully joined room", map[string]interface{}{
		"user_id":    req.UserId,
		"room_name":  req.RoomName,
		"session_id": req.SessionId,
	})

	return nil
}
```

### Step 6: Restart Services

```bash
# Stop services
docker-compose -f docker-compose.dev.yml down

# Rebuild and start
docker-compose -f docker-compose.dev.yml up --build
```

## Searching Logs in Better Stack

### Example Queries

1. **Find token expiration errors:**

   ```
   service:livekit-bridge AND error:*token is expired*
   ```

2. **Search by user ID:**

   ```
   service:livekit-bridge AND user_id:"isaiah@mentra.glass"
   ```

3. **Find room join events:**

   ```
   service:livekit-bridge AND message:*JoinRoom*
   ```

4. **Filter by log level:**

   ```
   service:livekit-bridge AND level:error
   ```

5. **Region-specific logs:**
   ```
   service:livekit-bridge AND extra.livekit_url:*france*
   ```

## Production Deployment

### For Porter/Kubernetes

Add to your deployment environment variables:

```yaml
env:
  - name: BETTERSTACK_SOURCE_TOKEN
    valueFrom:
      secretKeyRef:
        name: betterstack-secrets
        key: source-token
  - name: BETTERSTACK_INGESTING_HOST
    value: "sXXX.region.betterstackdata.com"
```

### For Docker Compose (Production)

```yaml
livekit-bridge:
  image: your-registry/livekit-bridge:latest
  environment:
    - BETTERSTACK_SOURCE_TOKEN=${BETTERSTACK_SOURCE_TOKEN}
    - BETTERSTACK_INGESTING_HOST=${BETTERSTACK_INGESTING_HOST}
  env_file:
    - .env.production
```

## Troubleshooting

### Logs Not Appearing in Better Stack

1. **Check environment variables:**

   ```bash
   docker-compose exec livekit-bridge env | grep BETTERSTACK
   ```

2. **Check container logs for Better Stack messages:**

   ```bash
   docker-compose logs livekit-bridge | grep BetterStack
   ```

   You should see:

   ```
   [BetterStack] Logger enabled, sending to sXXX.region.betterstackdata.com
   ```

3. **Test HTTP endpoint manually:**
   ```bash
   curl -X POST https://YOUR_INGESTING_HOST \
        -H "Authorization: Bearer YOUR_SOURCE_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"message":"Test from LiveKit bridge","level":"info","dt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'
   ```

### High Log Volume

Adjust batching settings in `logger/betterstack.go`:

```go
return NewBetterStackLogger(Config{
    Token:         token,
    IngestingHost: host,
    BatchSize:     50,           // Increase batch size
    FlushInterval: 10 * time.Second,  // Less frequent flushing
    Enabled:       enabled,
})
```

### Filtering Noisy Logs

Add log level filtering:

```go
func (l *BetterStackLogger) shouldLog(level string) bool {
    minLevel := os.Getenv("LOG_LEVEL")
    if minLevel == "error" && level == "debug" {
        return false
    }
    return true
}
```

## Debugging the Region Switch Issue

Now that you have Better Stack logging, here's how to debug the region switch:

### 1. Enable Debug Logging

```bash
LOG_LEVEL=debug
```

### 2. Add Region-Specific Logs

In your service.go:

```go
func (s *LiveKitBridgeService) JoinRoom(req *pb.JoinRoomRequest, stream pb.LiveKitBridge_JoinRoomServer) error {
    // Extract region from LiveKit URL
    region := extractRegion(req.LivekitUrl)

    s.bsLogger.LogInfo("JoinRoom request", map[string]interface{}{
        "user_id":     req.UserId,
        "session_id":  req.SessionId,
        "room_name":   req.RoomName,
        "livekit_url": req.LivekitUrl,
        "region":      region,
        "token_preview": req.AccessToken[:20] + "...",
    })

    // When connection fails
    if err != nil {
        s.bsLogger.LogError("Room connection failed", err, map[string]interface{}{
            "user_id":    req.UserId,
            "room_name":  req.RoomName,
            "region":     region,
            "error_type": getErrorType(err),
        })
    }
}
```

### 3. Track Region Switches

```go
func (s *LiveKitBridgeService) onRegionSwitch(userId, oldRegion, newRegion string) {
    s.bsLogger.LogWarn("Region switch detected", map[string]interface{}{
        "user_id":    userId,
        "old_region": oldRegion,
        "new_region": newRegion,
        "action":     "closing_old_connections",
    })
}
```

### 4. Search for the Issue

In Better Stack, search:

```
service:livekit-bridge AND user_id:"isaiah@mentra.glass" AND (error:*token* OR message:*region*)
```

## Next Steps

1. **Set up alerts** for token expiration errors
2. **Create dashboards** to visualize region distribution
3. **Monitor connection success rates** per region
4. **Track session lifetimes** across region switches

## Additional Resources

- [Better Stack Logs Documentation](https://betterstack.com/docs/logs/)
- [Go JSON Logging Best Practices](https://betterstack.com/community/guides/logging/go/)
- [LiveKit Server SDK Docs](https://docs.livekit.io/server-sdk-go/)
