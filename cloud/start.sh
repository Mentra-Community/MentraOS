#!/bin/bash
set -e  # Exit on error

# Cleanup function
cleanup() {
    echo "🧹 Cleaning up processes..."
    kill $GO_PID $BUN_PID 2>/dev/null || true
    rm -f "$LIVEKIT_GRPC_SOCKET"
    exit 1
}

trap cleanup SIGTERM SIGINT

# Set Unix socket path for gRPC communication
export LIVEKIT_GRPC_SOCKET=/tmp/livekit-bridge.sock

# Remove old socket if it exists
rm -f "$LIVEKIT_GRPC_SOCKET"

echo "🚀 Starting Go LiveKit gRPC bridge on Unix socket: $LIVEKIT_GRPC_SOCKET"
./livekit-bridge &
GO_PID=$!

# Wait for socket to be created (with timeout)
echo "⏳ Waiting for Unix socket to be created..."
for i in {1..10}; do
    if [ -S "$LIVEKIT_GRPC_SOCKET" ]; then
        echo "✅ Unix socket created successfully"
        break
    fi
    if [ $i -eq 10 ]; then
        echo "❌ ERROR: Unix socket not found at $LIVEKIT_GRPC_SOCKET after 10 seconds"
        echo "📋 Bridge may have failed to start. Check logs above."
        cleanup
    fi
    sleep 1
done

# Verify bridge process is still running
if ! kill -0 $GO_PID 2>/dev/null; then
    echo "❌ ERROR: Go bridge process died"
    cleanup
fi

# Verify socket permissions
ls -l "$LIVEKIT_GRPC_SOCKET"

echo "☁️ Starting Bun cloud service on :80..."
cd packages/cloud && PORT=80 bun run start &
BUN_PID=$!

echo "✅ Both services started successfully!"
echo "   Go Bridge PID: $GO_PID"
echo "   Bun Cloud PID: $BUN_PID"
echo "   Socket: $LIVEKIT_GRPC_SOCKET"

# Wait for any process to exit
wait -n

# If we get here, one process died - kill the other and exit with error
echo "❌ Service died, shutting down..."
cleanup
