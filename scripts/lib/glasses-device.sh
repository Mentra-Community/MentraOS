#!/usr/bin/env bash
# Shared Mentra Live / ASG device helpers for adb scripts.
# Source this file:  source "$(dirname "$0")/../lib/glasses-device.sh"
# or from mobile/scripts: source "$(dirname "$0")/../../scripts/lib/glasses-device.sh"

PKG_PROD="com.mentra.asg_client"
PKG_THIRDPARTY="com.mentra.asg_client.thirdparty"
MEDIA_ROOT_CURRENT="/storage/emulated/0/asg_media"

# List serials that are in "device" state (one per line).
list_ready_serials() {
  adb devices -l | awk 'NR>1 && $2=="device" {print $1}'
}

resolve_serial() {
  local serials
  serials="$(list_ready_serials || true)"

  if [[ -n "${ADB_SERIAL:-}" ]]; then
    # Fixed-string match — serials can contain regex metacharacters over TCP.
    if ! printf '%s\n' "$serials" | grep -Fqx -- "$ADB_SERIAL"; then
      echo "Error: device serial '$ADB_SERIAL' is not connected (or not in 'device' state)." >&2
      echo "Connected devices:" >&2
      adb devices -l >&2 || true
      return 1
    fi
    SERIAL="$ADB_SERIAL"
  else
    local count
    count="$(printf '%s\n' "$serials" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [[ "$count" -eq 0 ]]; then
      echo "Error: no adb devices in 'device' state." >&2
      adb devices -l >&2 || true
      echo "Connect Mentra Live (or set ADB_SERIAL=<serial>)." >&2
      return 1
    fi
    if [[ "$count" -gt 1 ]]; then
      echo "Error: multiple adb devices connected; set ADB_SERIAL to pick one:" >&2
      printf '%s\n' "$serials" >&2
      adb devices -l >&2 || true
      return 1
    fi
    SERIAL="$(printf '%s\n' "$serials" | sed '/^$/d' | head -n 1)"
  fi

  export SERIAL
  echo "Using serial: $SERIAL"
}

# True if package appears in `pm list packages` output (any state).
_package_listed() {
  local list="$1" pkg="$2"
  printf '%s\n' "$list" | grep -Fqx "package:${pkg}"
}

resolve_package() {
  if [[ -z "${SERIAL:-}" ]]; then
    resolve_serial || return 1
  fi

  # After ./asg_client/scripts/dev-setup.sh, stock stays installed but disabled
  # while .thirdparty is the live launcher. Prefer enabled packages so wipe /
  # restart hit the process that actually holds media files.
  local enabled all
  enabled="$(adb -s "$SERIAL" shell pm list packages -e 2>/dev/null | tr -d '\r' || true)"
  all="$(adb -s "$SERIAL" shell pm list packages 2>/dev/null | tr -d '\r' || true)"

  local en_tp=0 en_prod=0 has_tp=0 has_prod=0
  _package_listed "$enabled" "$PKG_THIRDPARTY" && en_tp=1
  _package_listed "$enabled" "$PKG_PROD" && en_prod=1
  _package_listed "$all" "$PKG_THIRDPARTY" && has_tp=1
  _package_listed "$all" "$PKG_PROD" && has_prod=1

  if [[ "$en_tp" -eq 1 ]]; then
    PACKAGE="$PKG_THIRDPARTY"
  elif [[ "$en_prod" -eq 1 ]]; then
    PACKAGE="$PKG_PROD"
  elif [[ "$has_tp" -eq 1 ]]; then
    PACKAGE="$PKG_THIRDPARTY"
  elif [[ "$has_prod" -eq 1 ]]; then
    PACKAGE="$PKG_PROD"
  else
    echo "Error: neither ${PKG_PROD} nor ${PKG_THIRDPARTY} is installed on $SERIAL." >&2
    return 1
  fi
  export PACKAGE
  echo "Using package: $PACKAGE"
}

resolve_media_roots() {
  if [[ -z "${PACKAGE:-}" ]]; then
    resolve_package || return 1
  fi
  MEDIA_ROOTS=("$MEDIA_ROOT_CURRENT" "/storage/emulated/0/Android/data/${PACKAGE}/files")
  export MEDIA_ROOTS
  echo "Media roots:"
  for r in "${MEDIA_ROOTS[@]}"; do
    echo "  - $r"
  done
}

stop_asg() {
  if [[ -z "${PACKAGE:-}" ]]; then
    resolve_package || return 1
  fi
  echo "Force-stopping $PACKAGE …"
  adb -s "$SERIAL" shell am force-stop "$PACKAGE"
}

PLACEHOLDER_ADB_SERIAL="0123456789ABCDEF"

# Ready devices as "serial<TAB>transport_id", one per line.
list_ready_transports() {
  adb devices -l | awk 'NR>1 && $2=="device" {
    transport=""
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^transport_id:/) {
        split($i, parts, ":")
        transport = parts[2]
      }
    }
    if (transport != "") print $1 "\t" transport
  }'
}

device_prop() {
  local transport="$1"
  local prop="$2"
  adb -t "$transport" shell getprop "$prop" </dev/null 2>/dev/null | tr -d '\r\n'
}

device_cid() {
  local transport="$1"
  adb -t "$transport" shell cat /sys/block/mmcblk0/device/cid </dev/null 2>/dev/null | tr -d '\r\n' | tr '[:upper:]' '[:lower:]'
}

# Rewrite later adb calls onto one device. Child processes inherit PATH.
# Pin by serial whenever one is stable across reboots; the adb server reassigns
# transport_id when the glasses drop and return, so a transport is only a last
# resort for placeholder/duplicate serials.
pin_adb_transport() {
  local transport="$1"
  local serial="${2:-}"
  local real dir selector_flag selector_value serial_matches=0
  real="$(command -v adb)"
  [ -n "$real" ] || return 1
  [ -n "$transport" ] || return 1
  # A real serial is the stable selector, but only when it maps to exactly one
  # ready device. The placeholder is shared by design, and distinct glasses can
  # report the same real serial, so count the ready matches before trusting it.
  if [ -n "$serial" ] && [ "$serial" != "$PLACEHOLDER_ADB_SERIAL" ]; then
    serial_matches="$(list_ready_transports | awk -F '\t' -v s="$serial" '$1==s {c++} END{print c+0}')"
  fi
  if [ "$serial_matches" -eq 1 ]; then
    selector_flag="-s"
    selector_value="$serial"
  else
    selector_flag="-t"
    selector_value="$transport"
  fi
  dir="${STOCK_UPDATE_ADB_BIN:-$(mktemp -d "${TMPDIR:-/tmp}/mentra-adb.XXXXXX")}"
  mkdir -p "$dir"
  cat > "$dir/adb" << EOF
#!/bin/bash
args=()
skip=""
for arg in "\$@"; do
  if [ -n "\$skip" ]; then
    skip=""
    continue
  fi
  case "\$arg" in
    -s|-t) skip=1; continue ;;
  esac
  args+=("\$arg")
done
exec $(printf '%q' "$real") $selector_flag $(printf '%q' "$selector_value") "\${args[@]}"
EOF
  chmod +x "$dir/adb"
  export PATH="$dir:$PATH"
  if [ "$selector_flag" = "-s" ]; then
    export ANDROID_SERIAL="$selector_value"
    unset ADB_TRANSPORT || true
  else
    export ADB_TRANSPORT="$transport"
    unset ANDROID_SERIAL ADB_SERIAL || true
  fi
  # Reboot waits read $SERIAL to tell USB from Wi-Fi ADB and run under `set -u`;
  # keep it populated even when we had to fall back to a transport_id.
  SERIAL="$serial"
  export SERIAL
  ADB=(adb)
}

# Select one Mentra Live. A unique real --serial is enough.
# --cid is required when the serial is missing, duplicated, or the placeholder.
# Prints a message and returns 11 when the choice is ambiguous or unmatched.
select_glasses_transport() {
  local want_serial="${1:-}"
  local want_cid="${2:-}"
  local rows count serial transport cid mac model matched=0
  rows="$(list_ready_transports || true)"
  count="$(printf '%s\n' "$rows" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$count" -eq 0 ]; then
    echo "Error: no adb device in 'device' state." >&2
    return 11
  fi

  if [ -n "$want_serial" ] && [ "$want_serial" != "$PLACEHOLDER_ADB_SERIAL" ]; then
    matched="$(printf '%s\n' "$rows" | awk -F '\t' -v serial="$want_serial" '$1==serial {c++} END{print c+0}')"
    if [ "$matched" -ne 1 ]; then
      echo "Error: serial $want_serial matched $matched ready devices." >&2
      printf '%s\n' "$rows" >&2
      return 11
    fi
    serial="$want_serial"
    transport="$(printf '%s\n' "$rows" | awk -F '\t' -v serial="$want_serial" '$1==serial {print $2; exit}')"
  elif [ -n "$want_cid" ]; then
    local found_serial="" found_transport=""
    while IFS=$'\t' read -r serial transport; do
      [ -n "$serial" ] || continue
      cid="$(device_cid "$transport")"
      if [ "$cid" = "$(printf '%s' "$want_cid" | tr '[:upper:]' '[:lower:]')" ]; then
        matched=$((matched + 1))
        found_serial="$serial"
        found_transport="$transport"
      fi
    done <<< "$rows"
    if [ "$matched" -ne 1 ]; then
      echo "Error: eMMC CID matched $matched ready devices. Connected glasses:" >&2
      while IFS=$'\t' read -r serial transport; do
        [ -n "$serial" ] || continue
        cid="$(device_cid "$transport" || true)"
        mac="$(device_prop "$transport" persist.mentra.live.mac || true)"
        echo "  serial=$serial cid=${cid:-unreadable} mac=${mac:-unreadable}" >&2
      done <<< "$rows"
      return 11
    fi
    serial="$found_serial"
    transport="$found_transport"
  elif [ "$count" -eq 1 ]; then
    IFS=$'\t' read -r serial transport <<< "$rows"
    if [ "$serial" = "$PLACEHOLDER_ADB_SERIAL" ]; then
      cid="$(device_cid "$transport")"
      echo "Error: the only ready device uses placeholder serial $PLACEHOLDER_ADB_SERIAL." >&2
      echo "Pass --cid $cid to select it." >&2
      return 11
    fi
  else
    echo "Error: multiple adb devices are ready. Pass --serial for a unique serial, or --cid when the serial is shared." >&2
    while IFS=$'\t' read -r serial transport; do
      [ -n "$serial" ] || continue
      cid="$(device_cid "$transport" || true)"
      mac="$(device_prop "$transport" persist.mentra.live.mac || true)"
      echo "  serial=$serial cid=${cid:-unreadable} mac=${mac:-unreadable}" >&2
    done <<< "$rows"
    return 11
  fi

  SELECTED_SERIAL="$serial"
  SELECTED_TRANSPORT="$transport"
  SELECTED_CID="$(device_cid "$transport")"
  SELECTED_MAC="$(device_prop "$transport" persist.mentra.live.mac)"
  SELECTED_MODEL="$(device_prop "$transport" ro.product.model)"
  if [ -z "$SELECTED_MAC" ]; then
    echo "Error: Bluetooth MAC on transport $transport is empty." >&2
    return 11
  fi
  export SELECTED_SERIAL SELECTED_TRANSPORT SELECTED_CID SELECTED_MAC SELECTED_MODEL
}
