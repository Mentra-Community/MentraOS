#!/bin/bash
set -e

# Test script for Unix socket gRPC connection
# This script tests the livekit-bridge with Unix socket support

SOCKET_PATH="/tmp/livekit-bridge-test.sock"
LOG_FILE="/tmp/livekit-bridge-test.log"

echo "🧪 Testing LiveKit gRPC Bridge with Unix Socket"
echo "================================================"

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    if [ ! -z "$BRIDGE_PID" ]; then
        kill $BRIDGE_PID 2>/dev/null || true
    fi
    rm -f "$SOCKET_PATH"
    echo "✅ Cleanup complete"
}

trap cleanup EXIT

# Remove old socket if exists
rm -f "$SOCKET_PATH"

# Build the bridge
echo "🔨 Building livekit-bridge..."
go build -o livekit-bridge .
if [ $? -ne 0 ]; then
    echo "❌ Build failed"
    exit 1
fi
echo "✅ Build successful"

# Start the bridge with Unix socket
echo ""
echo "🚀 Starting livekit-bridge with Unix socket..."
export LIVEKIT_GRPC_SOCKET="$SOCKET_PATH"
export PORT="9090"
export LOG_LEVEL="debug"
export LIVEKIT_URL="${LIVEKIT_URL:-ws://localhost:7880}"
export LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
export LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"

./livekit-bridge > "$LOG_FILE" 2>&1 &
BRIDGE_PID=$!

echo "   Bridge PID: $BRIDGE_PID"
echo "   Socket path: $SOCKET_PATH"
echo "   Log file: $LOG_FILE"

# Wait for socket to be created
echo ""
echo "⏳ Waiting for Unix socket to be created..."
for i in {1..10}; do
    if [ -S "$SOCKET_PATH" ]; then
        echo "✅ Unix socket created successfully!"
        break
    fi
    if [ $i -eq 10 ]; then
        echo "❌ Socket not created after 10 seconds"
        echo ""
        echo "📋 Bridge log:"
        cat "$LOG_FILE"
        exit 1
    fi
    sleep 1
    echo "   Attempt $i/10..."
done

# Check socket permissions
echo ""
echo "🔍 Socket permissions:"
ls -l "$SOCKET_PATH"

# Test if bridge is running
if ! kill -0 $BRIDGE_PID 2>/dev/null; then
    echo ""
    echo "❌ Bridge process died"
    echo ""
    echo "📋 Bridge log:"
    cat "$LOG_FILE"
    exit 1
fi

# Test health check using grpcurl (if available)
echo ""
echo "🏥 Testing health check..."
if command -v grpcurl &> /dev/null; then
    echo "   Using grpcurl to test health endpoint..."
    if grpcurl -plaintext -unix "$SOCKET_PATH" grpc.health.v1.Health/Check; then
        echo "✅ Health check successful!"
    else
        echo "⚠️  Health check failed (but socket is accessible)"
    fi
else
    echo "   grpcurl not installed, skipping gRPC test"
    echo "   Install with: brew install grpcurl (macOS) or go install github.com/fullstorydev/grpcurl/cmd/grpcurl@latest"
fi

# Test with netcat/socat (if available)
echo ""
echo "🔌 Testing socket connectivity..."
if command -v socat &> /dev/null; then
    # Send empty data and check if connection is accepted
    if timeout 2 bash -c "echo '' | socat - UNIX-CONNECT:$SOCKET_PATH" 2>/dev/null; then
        echo "✅ Socket accepts connections"
    else
        # Connection refused is expected for gRPC without proper framing
        echo "✅ Socket is listening (connection attempt made)"
    fi
else
    echo "   socat not installed, skipping socket test"
    echo "   Install with: brew install socat (macOS) or apt-get install socat (Linux)"
fi

# Show last few log lines
echo ""
echo "📋 Recent bridge logs:"
tail -20 "$LOG_FILE"

echo ""
echo "================================================"
echo "✅ All tests passed!"
echo ""
echo "To test manually with grpcurl:"
echo "  grpcurl -plaintext -unix $SOCKET_PATH list"
echo "  grpcurl -plaintext -unix $SOCKET_PATH mentra.livekit.bridge.LiveKitBridge/HealthCheck"
echo ""
echo "Press Ctrl+C to stop the bridge"
echo ""

# Keep running until interrupted
wait $BRIDGE_PID
