#!/bin/bash
# Normalize audio file to 0dB peak (matches camera_sound.wav volume)
# Usage: ./normalize-audio.sh <audio_file>
# Example: ./normalize-audio.sh battery/50.mp3

if [ -z "$1" ]; then
  echo "Usage: $0 <audio_file>"
  echo "Example: $0 battery/50.mp3"
  exit 1
fi

if [ ! -f "$1" ]; then
  echo "Error: File '$1' not found"
  exit 1
fi

# Get current max volume
max_vol=$(ffmpeg -i "$1" -af "volumedetect" -f null /dev/null 2>&1 | grep "max_volume" | awk '{print $5}' | tr -d '-')

if [ -z "$max_vol" ]; then
  echo "Error: Could not detect volume level"
  exit 1
fi

echo "Current max volume: -${max_vol} dB"
echo "Normalizing to 0 dB peak..."

# Get file extension
ext="${1##*.}"
filename=$(basename "$1")
tmpfile="/tmp/normalized_${filename}"

# Normalize based on extension
if [ "$ext" = "mp3" ]; then
  ffmpeg -y -i "$1" -af "volume=${max_vol}dB" -c:a libmp3lame -q:a 2 "$tmpfile" 2>/dev/null
elif [ "$ext" = "wav" ]; then
  ffmpeg -y -i "$1" -af "volume=${max_vol}dB" "$tmpfile" 2>/dev/null
else
  ffmpeg -y -i "$1" -af "volume=${max_vol}dB" "$tmpfile" 2>/dev/null
fi

if [ $? -eq 0 ]; then
  mv "$tmpfile" "$1"
  echo "Done: $1 normalized to 0 dB peak"
else
  echo "Error: Normalization failed"
  exit 1
fi
