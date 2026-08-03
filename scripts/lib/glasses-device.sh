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

resolve_package() {
  if [[ -z "${SERIAL:-}" ]]; then
    resolve_serial || return 1
  fi
  local pkgs
  pkgs="$(adb -s "$SERIAL" shell pm list packages 2>/dev/null | tr -d '\r' || true)"
  local has_prod=0 has_tp=0
  printf '%s\n' "$pkgs" | grep -Fqx "package:${PKG_PROD}" && has_prod=1
  printf '%s\n' "$pkgs" | grep -Fqx "package:${PKG_THIRDPARTY}" && has_tp=1

  if [[ "$has_prod" -eq 1 ]]; then
    PACKAGE="$PKG_PROD"
  elif [[ "$has_tp" -eq 1 ]]; then
    PACKAGE="$PKG_THIRDPARTY"
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
