#!/bin/bash

# Mentra Live Stream Viewer with Auto-Reconnect

STREAM_URL="rtmp://0.0.0.0:1935/s/streamKey"

echo "🎥 Starting Mentra Live viewer..."
echo "🔁 Auto-reconnect enabled. Press Ctrl+C to stop."

# Trap SIGINT (Ctrl+C) to exit gracefully
trap 'echo "🛑 Stopping viewer..."; exit 0' INT

while true; do
  ffplay -hide_banner -loglevel warning \
    -fflags nobuffer \
    -flags low_delay \
    -framedrop \
    -strict experimental \
    -infbuf \
    -listen 1 \
    -i "$STREAM_URL" &
  
  FFPLAY_PID=$!
  wait $FFPLAY_PID
  
  echo "⚠️ Stream disconnected. Reconnecting in 1 second..."
  sleep 1
done

