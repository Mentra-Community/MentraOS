#!/usr/bin/env bash
# Round 2: BLE photo (patient) + RTMP on a free port (-f flv, Docker owns 1935).
set -uo pipefail
cd "$(dirname "$0")"
MATCH="${1:-DA08}"
RTMP_PORT=19355
OUT=/tmp/live-e2e2-report.txt
: > "$OUT"
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT"; }

# -- connect (wait for advertising, up to 10m) --
say "waiting for $MATCH..."
deadline=$(( $(date +%s) + 600 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if bun glasses.mjs status 2>/dev/null | grep -q '"connected": true'; then break; fi
  seen=$(./run.sh scan.mjs 8 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except: d={'devices':[]}
print(next((x['name'] for x in d['devices'] if '$MATCH'.lower() in (x['name']+(x.get('serial') or '')).lower()), ''))")
  if [ -n "$seen" ]; then bun glasses.mjs connect "$MATCH" 60 >/dev/null 2>&1; fi
  bun glasses.mjs status 2>/dev/null | grep -q '"connected": true' && break
  sleep 30
done
bun glasses.mjs status 2>/dev/null | grep -q '"connected": true' || { say "RESULT: could not connect"; exit 1; }
say "connected ✓"
sleep 2

# -- TEST A: BLE photo, patient (compression + 400B packs takes ~1min) --
say "TEST A: BLE photo (patient wait)"
P0=$(bun glasses.mjs photos 2>/dev/null | python3 -c "import json,sys;print(len(json.load(sys.stdin)['photos']))")
bun glasses.mjs photo ble small > /tmp/e2e2-ble.json 2>&1   # small size -> faster BLE transfer
say "  response: $(cat /tmp/e2e2-ble.json | tr -d ' \n' | head -c 160)"
P1=$(bun glasses.mjs photos 2>/dev/null | python3 -c "import json,sys;print(len(json.load(sys.stdin)['photos']))")
if [ "$P1" -gt "$P0" ]; then
  say "  ✅ BLE photo assembled: $(bun glasses.mjs photos 2>/dev/null | python3 -c "import json,sys;p=json.load(sys.stdin)['photos'][-1];print(p['file'].split('/')[-1],p['bytes'],'bytes')")"
else
  say "  ❌ BLE photo still failing; pack trace:"
  bun glasses.mjs logs 2>/dev/null | grep -E "file pack|file transfer" | tail -6 | tee -a "$OUT"
fi

# -- TEST B: RTMP on free port with -f flv --
say "TEST B: RTMP -> ffmpeg on :$RTMP_PORT"
IP=$(bun glasses.mjs status 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['lanIp'])")
rm -f /tmp/glasses_stream.flv
ffmpeg -hide_banner -loglevel warning -y -listen 1 -timeout 60 -f flv \
  -i "rtmp://0.0.0.0:$RTMP_PORT/live/harness" -c copy -t 15 /tmp/glasses_stream.flv > /tmp/ffmpeg-rtmp.log 2>&1 &
FFPID=$!
sleep 1
kill -0 $FFPID 2>/dev/null || { say "  ffmpeg listener died: $(cat /tmp/ffmpeg-rtmp.log)"; exit 1; }
bun glasses.mjs stream start "rtmp://$IP:$RTMP_PORT/live/harness" > /tmp/e2e2-stream.json 2>&1
say "  start_stream: $(cat /tmp/e2e2-stream.json | tr -d ' \n' | head -c 120)"
for i in 1 2 3 4; do sleep 6; bun glasses.mjs live '{"type":"keep_stream_alive"}' >/dev/null 2>&1; done
wait $FFPID 2>/dev/null
bun glasses.mjs stream stop >/dev/null 2>&1
if [ -s /tmp/glasses_stream.flv ]; then
  INFO=$(ffprobe -v error -select_streams v -show_entries stream=codec_name,width,height -show_entries format=duration,size -of json /tmp/glasses_stream.flv 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin); s=(d.get('streams') or [{}])[0]; f=d.get('format',{})
print(f\"{s.get('codec_name')} {s.get('width')}x{s.get('height')}, {float(f.get('duration') or 0):.1f}s, {int(f.get('size') or 0)//1024}KB\")" 2>/dev/null)
  say "  ✅ STREAM RECORDED: /tmp/glasses_stream.flv ($INFO)"
else
  say "  ❌ no stream recorded. ffmpeg: $(tail -2 /tmp/ffmpeg-rtmp.log | tr '\n' ' ')"
  say "  stream events: $(bun glasses.mjs events 2>/dev/null | grep stream_status | tail -3 | tr '\n' ' ')"
fi

bun glasses.mjs stream stop >/dev/null 2>&1
say "DONE."
