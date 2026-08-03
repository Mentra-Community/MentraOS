#!/usr/bin/env bash
# Wipe Mentra Live media (asg_media + legacy). Default is dry-run; pass --yes to delete.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../scripts/lib/glasses-device.sh
source "${SCRIPT_DIR}/../../scripts/lib/glasses-device.sh"

# Capture package dir on asg_media is always this name (FileManagerImpl.getDefaultPackageName),
# even when the installed APK is the .thirdparty variant.
CAMERA_DIR_CURRENT="com.mentra.asg_client.camera"

DO_YES=0
DO_DRY=0
for arg in "$@"; do
  case "$arg" in
    --yes) DO_YES=1 ;;
    --dry-run) DO_DRY=1 ;;
    -h|--help)
      echo "Usage: $0 [--dry-run] [--yes]"
      echo "  Default mode is dry-run (list only). Pass --yes to actually delete."
      echo "  ADB_SERIAL=…  optional; if unset, requires exactly one connected device"
      exit 0
      ;;
  esac
done

# Default is dry-run unless --yes
DRY_RUN=1
if [[ "$DO_YES" -eq 1 ]]; then
  DRY_RUN=0
fi
# Explicit --dry-run always wins over accidental --yes together
if [[ "$DO_DRY" -eq 1 ]]; then
  DRY_RUN=1
fi

resolve_serial
resolve_package
resolve_media_roots

count_matches() {
  local root="$1"
  adb -s "$SERIAL" shell "
    root='$root'
    pkg='$PACKAGE'
    cam_current='$CAMERA_DIR_CURRENT'
    n=0
    if [ ! -d \"\$root\" ]; then echo 0; exit 0; fi
    # Prefer the fixed asg_media camera dir; also cover legacy \${pkg}.camera when distinct.
    prev_cam=\"\"
    for cam_name in \"\$cam_current\" \"\${pkg}.camera\"; do
      [ \"\$cam_name\" = \"\$prev_cam\" ] && continue
      prev_cam=\"\$cam_name\"
      cam=\"\$root/\$cam_name\"
      [ -d \"\$cam\" ] || continue
      for d in \"\$cam\"/IMG_* \"\$cam\"/VID_* \"\$cam\"/BUFFER_*; do
        [ -e \"\$d\" ] || continue
        n=\$((n+1))
      done
    done
    for d in \"\$root\"/IMG_* \"\$root\"/VID_*; do
      [ -e \"\$d\" ] || continue
      n=\$((n+1))
    done
    for d in photos videos audio temp thumbnails photo_queue; do
      if [ -d \"\$root/\$d\" ]; then
        n=\$((n + \$(find \"\$root/\$d\" -type f 2>/dev/null | wc -l)))
      fi
    done
    if [ -d \"\$root/media_queue\" ]; then
      n=\$((n + \$(find \"\$root/media_queue\" -type f 2>/dev/null | wc -l)))
    fi
    echo \$n
  " 2>/dev/null | tr -d '\r' | tail -n 1
}

wipe_root() {
  local root="$1"
  local dry="$2"
  adb -s "$SERIAL" shell "
    root='$root'
    pkg='$PACKAGE'
    cam_current='$CAMERA_DIR_CURRENT'
    dry='$dry'
    log() { echo \"\$@\"; }
    if [ ! -d \"\$root\" ]; then
      log \"missing: \$root\"
      exit 0
    fi
    remove_path() {
      p=\"\$1\"
      [ -e \"\$p\" ] || return 0
      if [ \"\$dry\" = \"1\" ]; then
        log \"would delete: \$p\"
      else
        rm -rf \"\$p\"
        log \"deleted: \$p\"
      fi
    }
    wipe_camera_dir() {
      cam=\"\$1\"
      [ -d \"\$cam\" ] || return 0
      for d in \"\$cam\"/IMG_* \"\$cam\"/VID_* \"\$cam\"/BUFFER_*; do
        remove_path \"\$d\"
      done
      for f in \"\$cam\"/*; do
        [ -e \"\$f\" ] || continue
        base=\$(basename \"\$f\")
        case \"\$base\" in
          IMG_*|VID_*|*.jpg|*.jpeg|*.mp4|*.png) remove_path \"\$f\" ;;
        esac
      done
    }
    wipe_camera_dir \"\$root/\$cam_current\"
    if [ \"\${pkg}.camera\" != \"\$cam_current\" ]; then
      wipe_camera_dir \"\$root/\${pkg}.camera\"
    fi
    for d in \"\$root\"/IMG_* \"\$root\"/VID_*; do
      remove_path \"\$d\"
    done
    for d in photos videos audio temp thumbnails photo_queue; do
      remove_path \"\$root/\$d\"
    done
    # Clear queued media files, then reset manifest to a valid empty schema.
    mq=\"\$root/media_queue\"
    mf=\"\$mq/queue_manifest.json\"
    if [ -d \"\$mq\" ]; then
      if [ \"\$dry\" = \"1\" ]; then
        find \"\$mq\" -type f ! -name 'queue_manifest.json' 2>/dev/null | while IFS= read -r f; do
          log \"would delete: \$f\"
        done
        if [ -e \"\$mf\" ]; then log \"would reset: \$mf\"; fi
      else
        find \"\$mq\" -type f ! -name 'queue_manifest.json' -exec rm -f {} + 2>/dev/null || true
        mkdir -p \"\$mq\"
        ts=\$(date +%s000)
        printf '%s' \"{\\\"mediaItems\\\":[],\\\"lastUpdated\\\":\${ts}}\" > \"\$mf\"
        log \"reset manifest: \$mf\"
      fi
    fi
  " 2>/dev/null | tr -d '\r'
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN — would delete (pass --yes to apply):"
else
  echo "Deleting media (ASG will be force-stopped first)…"
  stop_asg
fi

GRAND=0
for ROOT in "${MEDIA_ROOTS[@]}"; do
  c="$(count_matches "$ROOT" || echo 0)"
  c="$(echo "$c" | tr -d '[:space:]')"
  [[ -z "$c" ]] && c=0
  GRAND=$((GRAND + c))
  echo "--- $ROOT (approx entries: $c) ---"
  wipe_root "$ROOT" "$DRY_RUN"
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN complete. Approx entries that would be touched: $GRAND"
else
  echo "Wipe complete. Approx entries considered: $GRAND"
fi
