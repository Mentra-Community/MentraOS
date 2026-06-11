#!/usr/bin/env bash
# Mentra Live media e2e: WiFi photo -> laptop, BLE photo fallback, RTMP stream.
#
# Patient + gentle: scans first and only connects when the glasses are actually
# advertising (i.e. awake and not held by a phone). Single connect per attempt,
# no tight reconnect loops. Logs every step; safe to run unattended.
#
#   ./live-e2e.sh <serialOrNameSuffix> [maxWaitMinutes]
set -uo pipefail
cd "$(dirname "$0")"
MATCH="${1:-DA08}"
MAX_MIN="${2:-12}"
OUT=/tmp/live-e2e-report.txt
: > "$OUT"
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT"; }

# -- 0. wait for the glasses to advertise -------------------------------------
say "waiting for $MATCH to advertise (up to ${MAX_MIN}m; wake them / keep off phone)..."
deadline=$(( $(date +%s) + MAX_MIN * 60 ))
seen=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  seen=$(./run.sh scan.mjs 8 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except: d={'devices':[]}
print(next((x['name'] for x in d['devices'] if '$MATCH'.lower() in (x['name']+(x.get('serial') or '')).lower()), ''))
")
  [ -n "$seen" ] && break
  sleep 35
done
if [ -z "$seen" ]; then say "RESULT: glasses never advertised — e2e pending hardware. All receivers are built+selftested."; exit 1; fi
say "found: $seen — connecting"

# -- 1. connect ----------------------------------------------------------------
bun glasses.mjs connect "$MATCH" 60 > /tmp/e2e-conn.json 2>&1
ok=$(python3 -c "import json;print(json.load(open('/tmp/e2e-conn.json')).get('connected', json.load(open('/tmp/e2e-conn.json')).get('ok', False))" 2>/dev/null || echo False)
if ! bun glasses.mjs status 2>/dev/null | grep -q '"connected": true'; then
  say "RESULT: connect failed ($(tail -1 /tmp/e2e-conn.json 2>/dev/null))"; exit 1
fi
say "connected ✓"
sleep 2

# -- 2. glasses wifi state ------------------------------------------------------
bun glasses.mjs live '{"type":"request_wifi_status"}' >/dev/null 2>&1
sleep 3
WIFI=$(bun glasses.mjs events 2>/dev/null | python3 -c "
import json,sys
w={}
for l in sys.stdin:
    e=json.loads(l)
    if e.get('type')=='wifi': w=e
print(json.dumps({'connected':w.get('connected'),'ssid':w.get('ssid'),'ip':w.get('ip')}))")
say "glasses wifi: $WIFI"

# -- 3. WiFi photo (webhook to the laptop media receiver) -----------------------
say "TEST 1: WiFi photo -> laptop webhook"
P0=$(bun glasses.mjs photos 2>/dev/null | python3 -c "import json,sys;print(len(json.load(sys.stdin)['photos']))")
bun glasses.mjs photo wifi medium > /tmp/e2e-photo-wifi.json 2>&1
say "  response: $(cat /tmp/e2e-photo-wifi.json | tr -d '\n' | head -c 200)"
sleep 6
P1=$(bun glasses.mjs photos 2>/dev/null | python3 -c "import json,sys;print(len(json.load(sys.stdin)['photos']))")
if [ "$P1" -gt "$P0" ]; then
  say "  ✅ WiFi photo LANDED on laptop: $(bun glasses.mjs photos 2>/dev/null | python3 -c "import json,sys;p=json.load(sys.stdin)['photos'][-1];print(p['file'],p['bytes'],'bytes')")"
else
  say "  ❌ no WiFi upload received (glasses wifi: $WIFI)"
fi

# -- 4. BLE photo (file packets on 72FF) -----------------------------------------
say "TEST 2: BLE photo -> 72FF file transfer"
P0=$P1
bun glasses.mjs photo ble medium > /tmp/e2e-photo-ble.json 2>&1
say "  response: $(cat /tmp/e2e-photo-ble.json | tr -d '\n' | head -c 200)"
sleep 4
P1=$(bun glasses.mjs photos 2>/dev/null | python3 -c "import json,sys;print(len(json.load(sys.stdin)['photos']))")
if [ "$P1" -gt "$P0" ]; then
  say "  ✅ BLE photo assembled on laptop: $(bun glasses.mjs photos 2>/dev/null | python3 -c "import json,sys;p=json.load(sys.stdin)['photos'][-1];print(p['file'],p['bytes'],'bytes')")"
else
  say "  ❌ BLE photo did not assemble (check daemon logs for file packets)"
fi

# -- 5. RTMP stream -> local ffmpeg listener -------------------------------------
say "TEST 3: RTMP stream -> local ffmpeg"
IP=$(bun glasses.mjs status 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['lanIp'])")
rm -f /tmp/glasses_stream.flv
ffmpeg -hide_banner -loglevel error -y -listen 1 -timeout 45 \
  -i "rtmp://0.0.0.0:1935/live/harness" -c copy -t 12 /tmp/glasses_stream.flv &
FFPID=$!
sleep 1
bun glasses.mjs stream start "rtmp://$IP:1935/live/harness" > /tmp/e2e-stream.json 2>&1
say "  start_stream sent: $(cat /tmp/e2e-stream.json | tr -d '\n' | head -c 150)"
# keep-alive while recording
for i in 1 2 3; do sleep 6; bun glasses.mjs live '{"type":"keep_stream_alive"}' >/dev/null 2>&1; done
wait $FFPID 2>/dev/null
bun glasses.mjs stream stop >/dev/null 2>&1
if [ -s /tmp/glasses_stream.flv ]; then
  INFO=$(ffprobe -v error -show_entries format=duration,size -select_streams v -show_entries stream=codec_name,width,height -of json /tmp/glasses_stream.flv 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
s=(d.get('streams') or [{}])[0]
f=d.get('format',{})
print(f\"{s.get('codec_name')} {s.get('width')}x{s.get('height')}, {float(f.get('duration',0)):.1f}s, {int(f.get('size',0))//1024}KB\")" 2>/dev/null)
  say "  ✅ STREAM RECORDED: /tmp/glasses_stream.flv ($INFO)"
else
  say "  ❌ no stream arrived (events: $(bun glasses.mjs events 2>/dev/null | grep -c stream || true) stream events)"
fi

# -- 6. recent stream/photo events + clean exit ----------------------------------
say "stream/photo events seen:"
bun glasses.mjs events 2>/dev/null | python3 -c "
import json,sys
for l in sys.stdin:
    e=json.loads(l)
    if any(k in str(e.get('type','')) for k in ('stream','photo')) or e.get('kind') in ('photo','photoSaved'):
        print('   ', {k:v for k,v in e.items() if k!='at'})" | tail -10 | tee -a "$OUT"
bun glasses.mjs disconnect >/dev/null 2>&1
say "disconnected cleanly. DONE."
