#!/usr/bin/env bash
#
# fps-thermal-test.sh — Mentra Live: measure device thermals across camera
# recording settings (resolution x fps), entirely over ADB. No build/flash.
#
# Drives the existing IntentCommandReceiver JSON command (start/stop video
# recording) and samples every thermal sensor the device exposes while
# recording, then ffprobes each clip to confirm the ACTUAL captured
# resolution/fps. Emits per-cell CSVs and a human-readable markdown summary.
#
# WHY the odd adb invocations (learned the hard way, see design doc):
#   1. JSON must be wrapped so `am` doesn't read ':' as a data URI. We use
#      adb shell "am ... --es json '{\"k\":\"v\"}'"  (outer dquote, escaped inner).
#   2. The broadcast MUST be directed with -p <pkg>, else Android's background
#      broadcast limits SILENTLY drop it ("Broadcast completed" but no effect).
#
# Usage:
#   ./fps-thermal-test.sh                 # default matrix, see DEFAULTS below
#   RECORD_SECS=120 COOLDOWN=1 ./fps-thermal-test.sh
#   MATRIX="1920x1080@30 1920x1080@15 1920x1080@5" ./fps-thermal-test.sh
#
set -uo pipefail

PKG="com.mentra.asg_client"
ACTION="$PKG.ACTION_SEND_COMMAND"
CAM_DIR="/sdcard/Android/data/$PKG/files/$PKG.camera"
CPU_ZONE="/sys/class/thermal/thermal_zone1/temp"   # mtktscpu
CPU_FREQ="/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"
# Note: GPU freq/util sysfs (/sys/kernel/ged/hal/*) are root-only on Mentra Live;
# GPU thermals come from the thermalservice HAL "GPU" sensor instead.

# ---- DEFAULTS (override via env) ------------------------------------------
RECORD_SECS="${RECORD_SECS:-180}"        # record duration per cell (s)
SAMPLE_SECS="${SAMPLE_SECS:-5}"          # thermal sample interval (s)
COOLDOWN="${COOLDOWN:-1}"                # 1 = cool to baseline between cells
COOL_DELTA="${COOL_DELTA:-3}"            # consider "cool" within this many C of baseline
COOL_MAX_WAIT="${COOL_MAX_WAIT:-600}"    # max cooldown wait (s)
IDLE_CPU_MAX="${IDLE_CPU_MAX:-45}"       # require CPU below this (C) before first run
OUTDIR="${OUTDIR:-thermal-out-$(date +%Y%m%d_%H%M%S)}"

# Matrix: resolution@fps. Bitrate is derived by the app (16Mbps w>=1920, else 8Mbps).
# Order: hottest-likely last so cooldowns are honest.
#
# WARNING: only sizes the Mentra Live sensor can actually record are included.
# 2560x1920 (1440p) and 3840x2160 (4K) are NOT supported — requesting one fails
# to record AND wedges the camera in a stuck recording. If you add them back and
# the camera hangs, recover with:
#   adb shell "am force-stop com.mentra.asg_client"   # then reconnect from the app
MATRIX="${MATRIX:-1280x720@30 1280x720@15 1280x720@5 1920x1080@30 1920x1080@15 1920x1080@5}"

# ---- helpers ---------------------------------------------------------------
c() { awk -v m="$1" 'BEGIN{printf "%.1f", m/1000}'; }   # millideg -> C

adb_one() {  # ensure exactly one device
  local n; n=$(adb devices | sed '1d' | grep -cw device)
  [ "$n" -eq 1 ] || { echo "ERROR: need exactly 1 adb device, found $n"; adb devices; exit 1; }
}

send() {  # send a JSON command (directed + escaped). $1 = json body. Returns adb's exit code.
  if ! adb shell "am broadcast -a $ACTION -p $PKG --es json '$1'" >/dev/null 2>&1; then
    echo "   ⚠️  send failed (adb broadcast exited non-zero): $1" >&2
    return 1
  fi
}

cpu_c() { local v; v=$(adb shell "cat $CPU_ZONE" 2>/dev/null | tr -d '\r'); [ -n "$v" ] && c "$v" || echo "NaN"; }

# portable file size in bytes (GNU coreutils `stat -c`, BSD/macOS `stat -f`)
file_size_bytes() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null || echo 0; }

# Read ALL named framework sensors from thermalservice HAL: "NAME=value" pairs.
# BSD-awk friendly: no 3-arg match(); use sub()/gsub() to carve fields.
hal_sensors() {
  adb shell "dumpsys thermalservice" 2>/dev/null | tr -d '\r' \
    | awk '/Current temperatures from HAL:/{f=1;next}
           f && /^[A-Za-z]/ && !/Temperature\{/ {f=0}
           f && /Temperature\{/{
             val=$0; sub(/.*mValue=/,"",val); sub(/[ ,].*/,"",val);
             nm=$0;  sub(/.*mName=/,"",nm);  sub(/[ ,}].*/,"",nm);
             if(nm!="") printf "%s=%s\n", nm, val
           }'
}
hal_status() { adb shell "dumpsys thermalservice" 2>/dev/null | tr -d '\r' | awk -F': ' '/^Thermal Status:/{print $2; exit}'; }

# Live (non -127) sysfs zones as "type=C" pairs.
sysfs_zones() {
  adb shell 'for z in /sys/class/thermal/thermal_zone*; do t=$(cat $z/type 2>/dev/null); v=$(cat $z/temp 2>/dev/null); echo "$t $v"; done' 2>/dev/null | tr -d '\r' \
    | awk '$2>-100000 && $2!="" {printf "%s=%.1f\n",$1,$2/1000}'
}

newest_dir() { adb shell "ls -t $CAM_DIR 2>/dev/null | grep $1 | head -1" 2>/dev/null | tr -d '\r'; }

# ---- preflight -------------------------------------------------------------
adb_one
mkdir -p "$OUTDIR"
echo "== Mentra Live FPS/Thermal matrix =="
echo "Device: $(adb devices -l | sed -n 2p)"
echo "Output: $OUTDIR/"
echo "Record ${RECORD_SECS}s/cell, sample ${SAMPLE_SECS}s, cooldown=$COOLDOWN (delta ${COOL_DELTA}C, max ${COOL_MAX_WAIT}s)"
echo

echo "-- Advertised camera AE FPS ranges --"
adb shell "dumpsys media.camera" 2>/dev/null | grep -A3 "aeAvailableTargetFpsRanges" | tr -d '\r' | sed 's/^/   /'
echo
echo "-- Live thermal zones (baseline) --"
sysfs_zones | sed 's/^/   /'
echo "-- HAL named sensors (baseline) --   status=$(hal_status)"
hal_sensors | sed 's/^/   /'
BASE_CPU=$(cpu_c); echo
echo "Baseline CPU (mtktscpu): ${BASE_CPU}C"

# Guard against an unreadable sensor: cpu_c() returns "NaN" on a failed read,
# which awk's `c+0` would silently coerce to 0 and slip past the idle check —
# producing a full run of invalid thermal data. Fail fast instead.
case "$BASE_CPU" in
  ''|NaN|nan) echo "ERROR: could not read CPU temperature from $CPU_ZONE (got '${BASE_CPU}'). Check the device connection / sensor path."; exit 1;;
esac

awk -v c="$BASE_CPU" -v m="$IDLE_CPU_MAX" 'BEGIN{exit !(c+0<=m+0)}' \
  || { echo "ERROR: CPU ${BASE_CPU}C above idle threshold ${IDLE_CPU_MAX}C. Let it cool."; exit 1; }

# discover the union of HAL sensor names for stable CSV columns
HAL_NAMES=$(hal_sensors | awk -F= '{print $1}' | sort -u | tr '\n' ' ')
echo "HAL sensors tracked: $HAL_NAMES"
echo

SUMMARY="$OUTDIR/SUMMARY.md"
: > "$SUMMARY"

# ---- per-cell run ----------------------------------------------------------
run_cell() {
  local cell="$1"                       # e.g. 1920x1080@30
  local res="${cell%@*}" fps="${cell#*@}"
  local w="${res%x*}" h="${res#*x}"
  local rid; rid="m_${w}_${h}_${fps}"
  local csv="$OUTDIR/cell_${w}x${h}_${fps}fps.csv"
  echo "============================================================"
  echo ">> CELL ${res} @ ${fps}fps   (requestId=$rid)"

  # cooldown to baseline
  if [ "$COOLDOWN" = "1" ]; then
    local waited=0
    while :; do
      local cur; cur=$(cpu_c)
      awk -v a="$cur" -v b="$BASE_CPU" -v d="$COOL_DELTA" 'BEGIN{exit !((a-b)<=d)}' && break
      [ "$waited" -ge "$COOL_MAX_WAIT" ] && { echo "   cooldown cap hit at ${cur}C"; break; }
      printf "\r   cooling: CPU %sC (target <= %.1fC) waited %ss " "$cur" "$(awk -v b=$BASE_CPU -v d=$COOL_DELTA 'BEGIN{print b+d}')" "$waited"
      sleep 5; waited=$((waited+5))
    done; echo
  fi

  local start_cpu; start_cpu=$(cpu_c)
  echo "   start CPU=${start_cpu}C — starting recording"
  if ! send "{\"type\":\"start_video_recording\",\"requestId\":\"$rid\",\"save\":true,\"settings\":{\"width\":$w,\"height\":$h,\"fps\":$fps}}"; then
    echo "   ⚠️  skipping cell ${cell}: failed to dispatch start command"
    return 1
  fi
  sleep 2  # let recording actually engage

  # CSV header
  echo "t_s,cpu_zone1_C,$(echo $HAL_NAMES | tr ' ' ','),thermal_status,cpu_khz" > "$csv"

  local t=0
  while [ "$t" -lt "$RECORD_SECS" ]; do
    local cpuz status cf v halsnap halcols
    cpuz=$(cpu_c)
    # snapshot HAL sensors once, then look up each tracked name (bash3.2: no assoc arrays)
    halsnap=$(hal_sensors)
    halcols=""
    for name in $HAL_NAMES; do
      v=$(printf '%s\n' "$halsnap" | awk -F= -v n="$name" '$1==n{print $2; exit}')
      halcols+="${v:-NaN},"
    done
    status=$(hal_status)
    cf=$(adb shell "cat $CPU_FREQ" 2>/dev/null | tr -d '\r'); cf=${cf:-NaN}
    echo "$t,$cpuz,${halcols}${status},$cf" >> "$csv"
    printf "\r   t=%3ss  CPU=%sC  status=%s  " "$t" "$cpuz" "$status"
    sleep "$SAMPLE_SECS"; t=$((t+SAMPLE_SECS))
  done
  echo

  send "{\"type\":\"stop_video_recording\",\"requestId\":\"$rid\"}"
  sleep 3
  local end_cpu; end_cpu=$(cpu_c)

  # pull + ffprobe actual settings
  local dir mp4 probe aw ah afps nbf dur
  dir=$(newest_dir "$rid")
  mp4="$OUTDIR/clip_${w}x${h}_${fps}fps.mp4"
  adb pull "$CAM_DIR/$dir/base.mp4" "$mp4" >/dev/null 2>&1
  if [ -f "$mp4" ]; then
    probe=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate,nb_frames,duration -of default=noprint_wrappers=1 "$mp4" 2>/dev/null)
    aw=$(echo "$probe"|awk -F= '/^width/{print $2}')
    ah=$(echo "$probe"|awk -F= '/^height/{print $2}')
    afps=$(echo "$probe"|awk -F= '/avg_frame_rate/{print $2}'|awk -F/ '{if($2)printf "%.1f",$1/$2; else print $1}')
    dur=$(echo "$probe"|awk -F= '/^duration/{printf "%.1f",$2}')
  else
    aw=ERR; ah=ERR; afps=ERR; dur=ERR
  fi

  # steady-state = mean CPU over last third of samples; peak = max
  local ss peak fsize_mb
  ss=$(awk -F, 'NR>1{a[NR]=$2;n=NR} END{s=0;c=0;for(i=int(n*2/3);i<=n;i++){s+=a[i];c++} if(c)printf "%.1f",s/c}' "$csv")
  peak=$(awk -F, 'NR>1{if($2>m)m=$2} END{printf "%.1f",m}' "$csv")
  local maxstatus; maxstatus=$(awk -F, 'NR>1{c=$(NF-1); if(c>m)m=c} END{print m+0}' "$csv")
  [ -f "$mp4" ] && fsize_mb=$(awk -v b="$(file_size_bytes "$mp4")" 'BEGIN{printf "%.1f",b/1048576}') || fsize_mb=NaN

  # record a row for the master table  (req_res req_fps act_res act_fps dur ss peak dStatus startCPU endCPU sizeMB)
  echo "${res}|${fps}|${aw}x${ah}|${afps}|${dur}|${ss}|${peak}|${maxstatus}|${start_cpu}|${end_cpu}|${fsize_mb}" >> "$OUTDIR/.rows"
  echo "   done: actual ${aw}x${ah}@${afps}fps  steadyCPU=${ss}C peak=${peak}C maxStatus=${maxstatus} size=${fsize_mb}MB"
}

# ---- main loop -------------------------------------------------------------
: > "$OUTDIR/.rows"
for cell in $MATRIX; do run_cell "$cell"; done

# ---- summary table ---------------------------------------------------------
{
  echo "# Mentra Live — FPS/Resolution vs Thermals"
  echo
  echo "- Baseline CPU (mtktscpu): **${BASE_CPU}C**, charger: $(adb shell dumpsys battery|grep -m1 'powered: true'>/dev/null && echo ON || echo OFF)"
  echo "- Record ${RECORD_SECS}s/cell, sampled ${SAMPLE_SECS}s. steadyCPU = mean of last 1/3 of samples."
  echo "- maxStatus = peak framework thermal-throttle severity (0=none,1=light,2=moderate,3=severe...). >0 means the device officially throttled."
  echo "- Bitrate is app-derived: 16Mbps for width>=1920, 8Mbps for 720p. So size reflects bitrate x duration, not FPS."
  echo
  echo "| Req res | Req fps | Actual | Steady CPU | Peak CPU | ΔvsBase | maxStatus | size |"
  echo "|---|---|---|---|---|---|---|---|"
  while IFS='|' read -r res fps act afps dur ss peak st scpu ecpu sz; do
    delta=$(awk -v a="$ss" -v b="$BASE_CPU" 'BEGIN{printf "%+.1f", a-b}')
    printf "| %s | %s | %s@%s | %sC | %sC | %sC | %s | %sMB |\n" "$res" "$fps" "$act" "$afps" "$ss" "$peak" "$delta" "$st" "$sz"
  done < "$OUTDIR/.rows"
  echo
  echo "## FPS effect at fixed resolution (steady CPU)"
  for r in 1280x720 1920x1080; do
    line=$(awk -F'|' -v r="$r" '$1==r{printf "%s@%sfps=%sC  ",$1,$2,$6}' "$OUTDIR/.rows")
    [ -n "$line" ] && echo "- **$r**: $line"
  done
} | tee "$SUMMARY"

echo
echo "Wrote $SUMMARY and per-cell CSVs + clips in $OUTDIR/"
