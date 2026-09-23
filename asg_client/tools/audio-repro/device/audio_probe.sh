#!/system/bin/sh
# Read-only ALSA PCM state probe for instrumentation level L1.
# Usage: audio_probe.sh OUT_FILE PERIOD_SECONDS
# Stops when /data/local/tmp/audio_probe.stop exists. Each sample records CLOCK_MONOTONIC-based
# /proc/uptime plus hw_params and status (hw_ptr, appl_ptr, tstamp) for every open PCM
# substream. These are MTK-side kernel values, not a physical I2S clock measurement.
OUT="$1"
PERIOD="${2:-0.02}"
STOP=/data/local/tmp/audio_probe.stop
rm -f "$STOP"
while [ ! -f "$STOP" ]; do
  {
    echo "@ $(cat /proc/uptime)"
    for d in /proc/asound/card*/pcm*p/sub* /proc/asound/card*/pcm*c/sub*; do
      st=$(cat "$d/status" 2>/dev/null)
      case "$st" in
        closed|"") continue ;;
      esac
      echo "== $d"
      cat "$d/hw_params" 2>/dev/null
      echo "$st"
    done
  } >> "$OUT"
  sleep "$PERIOD"
done
