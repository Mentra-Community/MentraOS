#!/bin/bash
set -e

echo "==================================="
echo "LiveKit Audio Capture & Analysis"
echo "==================================="
echo ""

# Configuration
CONTAINER="cloud"
OUTPUT_DIR="./audio-analysis"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "Step 1: Checking if audio capture is enabled..."
if docker exec "$CONTAINER" printenv DEBUG_CAPTURE_AUDIO 2>/dev/null | grep -q "true"; then
    echo -e "${GREEN}✓ Audio capture is enabled${NC}"
else
    echo -e "${YELLOW}⚠ Audio capture not enabled${NC}"
    echo ""
    echo "To enable, add to .env:"
    echo "  DEBUG_CAPTURE_AUDIO=true"
    echo ""
    echo "Then restart: docker-compose restart cloud"
    echo ""
    read -p "Would you like me to enable it now? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "DEBUG_CAPTURE_AUDIO=true" >> .env
        echo "Restarting cloud container..."
        docker-compose restart cloud
        echo ""
        echo -e "${GREEN}✓ Enabled and restarted${NC}"
        echo ""
        echo "Now connect your mobile device and enable the microphone."
        echo "Audio will be captured automatically for 5 seconds."
        echo ""
        read -p "Press Enter when you've captured audio..."
    else
        echo "Exiting. Enable capture and try again."
        exit 1
    fi
fi

echo ""
echo "Step 2: Looking for captured audio files..."

# Find the latest capture file
RAW_FILE=$(docker exec "$CONTAINER" ls -t /tmp/livekit-audio-*.raw 2>/dev/null | head -1 || echo "")

if [ -z "$RAW_FILE" ]; then
    echo -e "${RED}✗ No audio capture found${NC}"
    echo ""
    echo "Make sure you:"
    echo "  1. Enabled DEBUG_CAPTURE_AUDIO=true"
    echo "  2. Restarted cloud container"
    echo "  3. Connected mobile and enabled microphone"
    echo "  4. Waited for 5 seconds of capture"
    echo ""
    echo "Check logs: docker logs cloud | grep 'Audio capture'"
    exit 1
fi

echo -e "${GREEN}✓ Found: $RAW_FILE${NC}"

# Extract filename
BASENAME=$(basename "$RAW_FILE")
TXT_FILE="${RAW_FILE/.raw/.txt}"

echo ""
echo "Step 3: Copying files from container..."

docker cp "$CONTAINER:$RAW_FILE" "$OUTPUT_DIR/audio.raw"
docker cp "$CONTAINER:$TXT_FILE" "$OUTPUT_DIR/audio.txt" 2>/dev/null || echo "Note: Analysis file not found (may not be generated yet)"

echo -e "${GREEN}✓ Copied to $OUTPUT_DIR/${NC}"

echo ""
echo "Step 4: Converting to WAV (both endianness)..."

# Check if ffmpeg is available
if ! command -v ffmpeg &> /dev/null; then
    echo -e "${YELLOW}⚠ ffmpeg not found${NC}"
    echo "Install with: brew install ffmpeg (macOS) or apt-get install ffmpeg (Linux)"
    echo ""
    echo "Skipping WAV conversion, but you can still check the analysis below."
    echo ""
else
    # Convert as little-endian (standard)
    ffmpeg -f s16le -ar 16000 -ac 1 -i "$OUTPUT_DIR/audio.raw" "$OUTPUT_DIR/audio-le.wav" -y 2>/dev/null
    echo -e "${GREEN}✓ Created: audio-le.wav (little-endian)${NC}"

    # Convert as big-endian
    ffmpeg -f s16be -ar 16000 -ac 1 -i "$OUTPUT_DIR/audio.raw" "$OUTPUT_DIR/audio-be.wav" -y 2>/dev/null
    echo -e "${GREEN}✓ Created: audio-be.wav (big-endian)${NC}"
fi

echo ""
echo "Step 5: Analyzing audio..."
echo ""

# Show analysis if available
if [ -f "$OUTPUT_DIR/audio.txt" ]; then
    cat "$OUTPUT_DIR/audio.txt"
else
    # Manual analysis
    echo "==================================="
    echo "Manual Analysis"
    echo "==================================="

    # Get file size
    SIZE=$(stat -f%z "$OUTPUT_DIR/audio.raw" 2>/dev/null || stat -c%s "$OUTPUT_DIR/audio.raw" 2>/dev/null)
    SAMPLES=$((SIZE / 2))
    DURATION=$(echo "scale=2; $SAMPLES / 16000" | bc)

    echo "File: $OUTPUT_DIR/audio.raw"
    echo "Size: $SIZE bytes"
    echo "Samples: $SAMPLES"
    echo "Duration: ~${DURATION}s @ 16kHz"
    echo ""

    # Show first 64 bytes in hex
    echo "First 64 bytes (hex):"
    hexdump -n 64 -v -e '16/1 "%02x " "\n"' "$OUTPUT_DIR/audio.raw"
    echo ""
fi

echo ""
echo "==================================="
echo "Results Summary"
echo "==================================="
echo ""
echo "Files created in $OUTPUT_DIR/:"
echo "  - audio.raw (raw PCM16 data)"
echo "  - audio.txt (analysis report)"
if command -v ffmpeg &> /dev/null; then
    echo "  - audio-le.wav (as little-endian)"
    echo "  - audio-be.wav (as big-endian)"
fi
echo ""

if command -v ffmpeg &> /dev/null; then
    echo -e "${YELLOW}NEXT STEP: Listen to the audio files${NC}"
    echo ""
    echo "Play both WAV files and see which one sounds clear:"
    echo ""
    echo "  # macOS"
    echo "  afplay $OUTPUT_DIR/audio-le.wav"
    echo "  afplay $OUTPUT_DIR/audio-be.wav"
    echo ""
    echo "  # Linux"
    echo "  aplay $OUTPUT_DIR/audio-le.wav"
    echo "  aplay $OUTPUT_DIR/audio-be.wav"
    echo ""
    echo "  # Or open in any audio player"
    echo ""
    echo -e "${GREEN}If audio-le.wav is clear:${NC}"
    echo "  → Audio is already little-endian (correct)"
    echo "  → Set: LIVEKIT_PCM_ENDIAN=off"
    echo ""
    echo -e "${GREEN}If audio-be.wav is clear:${NC}"
    echo "  → Audio is big-endian (needs swapping)"
    echo "  → Set: LIVEKIT_PCM_ENDIAN=swap"
    echo ""
    echo -e "${RED}If both sound like static:${NC}"
    echo "  → Not an endianness issue"
    echo "  → Check mobile sends PCM16 (not compressed)"
    echo "  → Verify 16kHz mono"
    echo ""
fi

# Check logs for endianness detection
echo "==================================="
echo "Logs from Cloud Container"
echo "==================================="
echo ""

echo "Checking for endianness detection..."
docker logs "$CONTAINER" 2>&1 | grep -i "endianness detection" | tail -5 || echo "No endianness detection logs found"

echo ""
echo "Checking for first chunk analysis..."
docker logs "$CONTAINER" 2>&1 | grep -A 5 "First chunk - interpreted both ways" | tail -10 || echo "No first chunk logs found"

echo ""
echo "==================================="
echo "Done!"
echo "==================================="
echo ""
echo "Analyze the files in $OUTPUT_DIR/ and set the correct endianness in .env"
echo ""
