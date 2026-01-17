#!/bin/bash
# Generates test audio files for E2E testing
# Requires: ffmpeg, macOS (for 'say' command) or substitute with other TTS

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Generating test audio files..."

# Check for ffmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo "ERROR: ffmpeg is required but not installed"
    echo "Install with: brew install ffmpeg"
    exit 1
fi

# Generate hello-world.wav (~5 seconds)
if [ ! -f "hello-world.wav" ]; then
    echo "Creating hello-world.wav..."
    if command -v say &> /dev/null; then
        # macOS
        say -o temp.aiff "Hello world. Testing one two three. This is a test of the live captions feature."
        ffmpeg -y -i temp.aiff -ar 16000 -ac 1 -sample_fmt s16 hello-world.wav 2>/dev/null
        rm -f temp.aiff
    else
        echo "WARNING: 'say' command not available. Please provide hello-world.wav manually."
    fi
fi

# Generate numbers-count.wav (~8 seconds)
if [ ! -f "numbers-count.wav" ]; then
    echo "Creating numbers-count.wav..."
    if command -v say &> /dev/null; then
        say -o temp.aiff "One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten."
        ffmpeg -y -i temp.aiff -ar 16000 -ac 1 -sample_fmt s16 numbers-count.wav 2>/dev/null
        rm -f temp.aiff
    else
        echo "WARNING: 'say' command not available. Please provide numbers-count.wav manually."
    fi
fi

# Verify files
echo ""
echo "Generated files:"
for f in *.wav; do
    if [ -f "$f" ]; then
        duration=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$f" 2>/dev/null || echo "unknown")
        size=$(ls -lh "$f" | awk '{print $5}')
        echo "  $f - ${duration}s, $size"
    fi
done

echo ""
echo "Done! Audio files ready for E2E testing."
