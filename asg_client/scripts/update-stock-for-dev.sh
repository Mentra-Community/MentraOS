#!/bin/bash
#
# Bring Mentra Live firmware to the latest staging baseline before a third-party
# ASG Client takes over. The rolling manifest is downloaded exactly once; every
# artifact and transition in the rest of the run comes from that local snapshot.
#
# Usage:
#   ADB_SERIAL=<serial> ./scripts/update-stock-for-dev.sh
#   ./scripts/update-stock-for-dev.sh --manifest-url <https-url>
#   ./scripts/update-stock-for-dev.sh --resume-thirdparty

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$ASG_DIR/.." && pwd)"

DEFAULT_MANIFEST_URL="https://github.com/Mentra-Community/MentraOS/releases/download/staging-builds/staging_live_version.json"
MANIFEST_URL="${ASG_DEV_OTA_MANIFEST_URL:-$DEFAULT_MANIFEST_URL}"
RESUME_THIRDPARTY=false

# Officially signed ASG 36 bridge. Its deliberately high versionCode allows it
# to replace every old stock update, and it speaks to day-one BES firmware.
BRIDGE_APK_URL="https://drive.usercontent.google.com/download?id=165WODzaMXkvpL5V3PQ28391wQQietxSQ&export=download&confirm=t"
BRIDGE_APK_SHA256="8fbac72d3fb895548cdd2b213eb331f1d7b0e7532e4ad4a2233529a8170b9551"
BRIDGE_APK_SIZE="87174306"
BRIDGE_VERSION_CODE="99999999"

STOCK_PKG="com.mentra.asg_client"
DEV_PKG="com.mentra.asg_client.thirdparty"
RECOVERY_PKG="com.mentra.recovery"
LEGACY_UPDATER_PKG="com.augmentos.otaupdater"
STOCK_COMPONENT="$STOCK_PKG/com.mentra.asg_client.MainActivity"
DEV_COMPONENT="$DEV_PKG/com.mentra.asg_client.MainActivity"
COMMAND_RECEIVER="$STOCK_PKG/.receiver.IntentCommandReceiver"
LEGACY_STOCK_FILES="/storage/emulated/0/Android/data/$STOCK_PKG/files"
LEGACY_STOCK_PARENT="/storage/emulated/0/Android/data/$STOCK_PKG"
LEGACY_STOCK_BACKUP_PATH="/storage/emulated/0/asg/dev_setup_stock_files_backup"

WORK_DIR=""
DEVICE_MUTATED=false
SUCCESS=false
LEGACY_STOCK_BACKUP=""

usage() {
  echo "Usage: $0 [--manifest-url <https-url>] [--resume-thirdparty]"
}

fail() {
  echo ""
  echo "ERROR: $1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest-url)
      [ "$#" -ge 2 ] || fail "--manifest-url requires a URL"
      MANIFEST_URL="${2:-}"
      shift 2
      ;;
    --resume-thirdparty)
      RESUME_THIRDPARTY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

for command_name in adb curl jq python3; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command not found: $command_name"
done

source "$REPO_DIR/scripts/lib/glasses-device.sh"
if [ -n "${ANDROID_SERIAL:-}" ] && [ -z "${ADB_SERIAL:-}" ]; then
  ADB_SERIAL="$ANDROID_SERIAL"
  export ADB_SERIAL
fi
resolve_serial
ADB=(adb -s "$SERIAL")
export ANDROID_SERIAL="$SERIAL"

if [ "$RESUME_THIRDPARTY" = true ] \
  && ! "${ADB[@]}" shell pm path "$DEV_PKG" 2>/dev/null | tr -d '\r' | grep -q '^package:'; then
  fail "$DEV_PKG is not installed; run ./scripts/dev-setup.sh first"
fi

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "No SHA-256 tool found (need shasum or sha256sum)"
  fi
}

download_verified() {
  local label="$1"
  local url="$2"
  local expected_sha="$3"
  local expected_size="$4"
  local destination="$5"
  local actual_sha actual_size

  echo "Downloading $label..."
  curl --fail --location --retry 3 --retry-all-errors --output "${destination}.part" "$url"
  mv "${destination}.part" "$destination"

  actual_sha="$(sha256_file "$destination")"
  if [ "$actual_sha" != "$expected_sha" ]; then
    fail "$label SHA-256 mismatch (expected $expected_sha, got $actual_sha)"
  fi

  if [ -n "$expected_size" ]; then
    actual_size="$(wc -c < "$destination" | tr -d ' ')"
    if [ "$actual_size" != "$expected_size" ]; then
      fail "$label size mismatch (expected $expected_size, got $actual_size)"
    fi
  fi
  echo "Verified $label."
}

version_at_least() {
  local installed="$1"
  local target="$2"
  awk -v installed="$installed" -v target="$target" 'BEGIN {
    ni = split(installed, i, "."); nt = split(target, t, ".");
    n = ni > nt ? ni : nt;
    for (x = 1; x <= n; x++) {
      iv = (x <= ni ? i[x] : 0) + 0;
      tv = (x <= nt ? t[x] : 0) + 0;
      if (iv > tv) exit 0;
      if (iv < tv) exit 1;
    }
    exit 0;
  }'
}

firmware_suffix() {
  printf '%s\n' "$1" | sed -nE 's/.*_([0-9]{8}(\.[0-9]+)?)$/\1/p'
}

adb_online() {
  "${ADB[@]}" get-state >/dev/null 2>&1
}

package_version_code() {
  "${ADB[@]}" shell dumpsys package "$1" 2>/dev/null \
    | tr -d '\r' \
    | sed -n 's/.*versionCode=\([0-9][0-9]*\).*/\1/p' \
    | head -n 1
}

enable_stock_runtime() {
  local resolved_home
  if ! "${ADB[@]}" shell pm path "$STOCK_PKG" 2>/dev/null | tr -d '\r' | grep -q '^package:'; then
    "${ADB[@]}" shell cmd package install-existing "$STOCK_PKG" >/dev/null \
      || return 1
  fi
  "${ADB[@]}" shell pm enable "$STOCK_PKG" >/dev/null || return 1
  "${ADB[@]}" shell pm clear-package-preferred-activities "$STOCK_PKG" >/dev/null 2>&1 || true
  "${ADB[@]}" shell cmd package set-home-activity --user 0 "$STOCK_COMPONENT" >/dev/null \
    || return 1
  "${ADB[@]}" shell am start -n "$STOCK_COMPONENT" >/dev/null || return 1
  resolved_home="$("${ADB[@]}" shell cmd package resolve-activity --brief --user 0 \
    -a android.intent.action.MAIN \
    -c android.intent.category.HOME 2>/dev/null | tr -d '\r' | tail -n 1)"
  case "$resolved_home" in
    "$STOCK_PKG"/*) ;;
    *) return 1 ;;
  esac
}

enable_thirdparty_runtime() {
  local resolved_home
  "${ADB[@]}" shell am force-stop "$RECOVERY_PKG" >/dev/null 2>&1 || true
  "${ADB[@]}" shell pm disable-user --user 0 "$RECOVERY_PKG" >/dev/null 2>&1 || true
  "${ADB[@]}" shell am force-stop "$LEGACY_UPDATER_PKG" >/dev/null 2>&1 || true
  "${ADB[@]}" shell pm disable-user --user 0 "$LEGACY_UPDATER_PKG" >/dev/null 2>&1 || true
  "${ADB[@]}" shell pm enable "$DEV_PKG" >/dev/null
  "${ADB[@]}" shell pm disable-user --user 0 "$STOCK_PKG" >/dev/null
  "${ADB[@]}" shell pm clear-package-preferred-activities "$STOCK_PKG" >/dev/null 2>&1 || true
  "${ADB[@]}" shell pm clear-package-preferred-activities "$DEV_PKG" >/dev/null 2>&1 || true
  "${ADB[@]}" shell cmd package set-home-activity --user 0 "$DEV_COMPONENT" >/dev/null
  "${ADB[@]}" shell am start -a android.intent.action.MAIN \
    -c android.intent.category.HOME >/dev/null 2>&1 || true
  "${ADB[@]}" shell am start -n "$DEV_COMPONENT" >/dev/null

  "${ADB[@]}" shell pm list packages -e 2>/dev/null \
    | tr -d '\r' \
    | grep -Fqx "package:$DEV_PKG" \
    || fail "Could not re-enable $DEV_PKG after the firmware update"
  resolved_home="$("${ADB[@]}" shell cmd package resolve-activity --brief --user 0 \
    -a android.intent.action.MAIN \
    -c android.intent.category.HOME 2>/dev/null | tr -d '\r' | tail -n 1)"
  case "$resolved_home" in
    "$DEV_PKG"/*) ;;
    *) fail "Third-party package is enabled, but HOME resolved to ${resolved_home:-unknown}" ;;
  esac
}

preserve_legacy_stock_files() {
  local entry_count
  entry_count="$("${ADB[@]}" shell \
    "if [ -d '$LEGACY_STOCK_FILES' ]; then find '$LEGACY_STOCK_FILES' -mindepth 1 -print | wc -l; else echo 0; fi" \
    2>/dev/null | tr -d '\r ' | tail -n 1)"
  [[ "$entry_count" =~ ^[0-9]+$ ]] \
    || fail "Could not inventory legacy stock data before uninstall"
  if [ "$entry_count" -eq 0 ]; then
    return 0
  fi

  if "${ADB[@]}" shell test -e "$LEGACY_STOCK_BACKUP_PATH"; then
    fail "Unrestored legacy stock-data backup already exists at $LEGACY_STOCK_BACKUP_PATH"
  fi
  LEGACY_STOCK_BACKUP="$LEGACY_STOCK_BACKUP_PATH"
  echo "Preserving $entry_count legacy stock-data entries before removing the bridge..."
  "${ADB[@]}" shell mkdir -p /storage/emulated/0/asg
  "${ADB[@]}" shell mv "$LEGACY_STOCK_FILES" "$LEGACY_STOCK_BACKUP" \
    || fail "Could not preserve legacy stock data before uninstall"
  echo "Legacy stock data staged safely at $LEGACY_STOCK_BACKUP."
}

recover_orphaned_legacy_stock_files() {
  if ! "${ADB[@]}" shell test -d "$LEGACY_STOCK_BACKUP_PATH"; then
    return 0
  fi
  echo "Found legacy stock data preserved by an interrupted earlier run."
  LEGACY_STOCK_BACKUP="$LEGACY_STOCK_BACKUP_PATH"
  restore_legacy_stock_files \
    || fail "Could not restore interrupted-run data from $LEGACY_STOCK_BACKUP_PATH"
}

restore_legacy_stock_files() {
  if [ -z "$LEGACY_STOCK_BACKUP" ]; then
    return 0
  fi
  if ! "${ADB[@]}" shell test -d "$LEGACY_STOCK_BACKUP"; then
    LEGACY_STOCK_BACKUP=""
    return 0
  fi

  # Package installation may recreate an empty external-files directory. rmdir
  # refuses a non-empty destination. Prefer Toybox's -T so a concurrently
  # recreated directory makes mv fail instead of nesting the backup. Very old
  # builds lack -T, so detect and undo nesting before reporting failure there.
  "${ADB[@]}" shell mkdir -p "$LEGACY_STOCK_PARENT"
  "${ADB[@]}" shell rmdir "$LEGACY_STOCK_FILES" >/dev/null 2>&1 || true
  if "${ADB[@]}" shell test -e "$LEGACY_STOCK_FILES"; then
    echo "Legacy stock data remains safe at $LEGACY_STOCK_BACKUP." >&2
    return 1
  fi
  if ! "${ADB[@]}" shell mv -T "$LEGACY_STOCK_BACKUP" "$LEGACY_STOCK_FILES" >/dev/null 2>&1; then
    local nested_backup="$LEGACY_STOCK_FILES/${LEGACY_STOCK_BACKUP##*/}"
    if ! "${ADB[@]}" shell test -d "$LEGACY_STOCK_BACKUP"; then
      return 1
    fi
    if "${ADB[@]}" shell test -e "$LEGACY_STOCK_FILES"; then
      echo "Legacy stock data remains safe at $LEGACY_STOCK_BACKUP." >&2
      return 1
    fi
    "${ADB[@]}" shell mv "$LEGACY_STOCK_BACKUP" "$LEGACY_STOCK_FILES" || return 1
    if "${ADB[@]}" shell test -d "$nested_backup"; then
      "${ADB[@]}" shell mv "$nested_backup" "$LEGACY_STOCK_BACKUP" || {
        echo "Legacy stock data remains safe at $nested_backup." >&2
        return 1
      }
      echo "The stock-data directory was recreated during restore; preserved data was moved back to $LEGACY_STOCK_BACKUP." >&2
      return 1
    fi
  fi
  if "${ADB[@]}" shell test -e "$LEGACY_STOCK_BACKUP"; then
    return 1
  fi
  echo "Restored legacy stock data for migration by the staging ASG Client."
  LEGACY_STOCK_BACKUP=""
}

restore_safe_stock_on_failure() {
  if [ "$DEVICE_MUTATED" = true ] && adb_online; then
    echo "Restoring the stock launcher after the failed setup..." >&2
    "${ADB[@]}" shell am force-stop "$DEV_PKG" >/dev/null 2>&1 || true
    "${ADB[@]}" shell pm disable-user --user 0 "$DEV_PKG" >/dev/null 2>&1 || true
    restore_legacy_stock_files || true
    if enable_stock_runtime; then
      echo "Stock launcher restored." >&2
    else
      echo "Could not fully restore stock automatically; run ./scripts/restore-stock.sh." >&2
    fi
    "${ADB[@]}" shell pm enable "$RECOVERY_PKG" >/dev/null 2>&1 || true
    "${ADB[@]}" shell pm enable "$LEGACY_UPDATER_PKG" >/dev/null 2>&1 || true
  elif [ "$DEVICE_MUTATED" = true ] && [ -n "$LEGACY_STOCK_BACKUP" ]; then
    echo "Legacy stock data remains safe at $LEGACY_STOCK_BACKUP once ADB reconnects." >&2
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$SUCCESS" != true ]; then
    restore_safe_stock_on_failure
  fi
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf -- "$WORK_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

wait_for_boot_after_reboot() {
  local label="$1"
  local previous_boot_id="$2"
  local initial_start attempt_start now elapsed current_boot_id
  local explicit_reboot_attempts=0
  local saw_disconnect=false prompted=false explicit_reboot_sent=false
  [ -n "$previous_boot_id" ] || fail "Could not capture the pre-update Android boot ID"
  initial_start="$(date +%s)"
  attempt_start="$initial_start"

  echo "Waiting for $label reboot..."
  while true; do
    now="$(date +%s)"
    if adb_online; then
      current_boot_id="$("${ADB[@]}" shell cat /proc/sys/kernel/random/boot_id 2>/dev/null | tr -d '\r\n')"
      if [ -n "$current_boot_id" ] && [ "$current_boot_id" != "$previous_boot_id" ]; then
        break
      fi

      if [ "$explicit_reboot_sent" = true ]; then
        if [ $((now - attempt_start)) -ge 180 ]; then
          fail "$label stayed online without completing the explicit ADB reboot"
        fi
      elif [ "$saw_disconnect" = true ] || [ $((now - initial_start)) -ge 45 ]; then
        if [ "$explicit_reboot_attempts" -ge 3 ]; then
          fail "$label never accepted an explicit ADB reboot after three attempts"
        fi
        explicit_reboot_attempts=$((explicit_reboot_attempts + 1))
        echo "ADB returned without proof of an Android reboot; sending an explicit ADB reboot."
        if "${ADB[@]}" reboot >/dev/null 2>&1; then
          explicit_reboot_sent=true
          attempt_start="$now"
          saw_disconnect=false
          prompted=false
        else
          saw_disconnect=true
          attempt_start="$now"
          sleep 5
        fi
      fi
    else
      saw_disconnect=true
      elapsed=$((now - attempt_start))
      if [ "$elapsed" -ge 45 ] && [ "$prompted" = false ]; then
        echo ""
        echo "================================================================"
        if [[ "$SERIAL" == *:* ]]; then
          echo "Mentra Live rebooted, but Wi-Fi ADB did not reconnect after 45s."
          echo "Waiting for Wi-Fi ADB device $SERIAL to return..."
        else
          echo "Mentra Live rebooted, but USB ADB did not reconnect after 45s."
          echo "Unplug the Infinity Cable, then plug it back in."
          echo "The script will resume automatically when ADB returns."
        fi
        echo "================================================================"
        prompted=true
      fi
    fi
    sleep 2
  done

  attempt_start="$(date +%s)"
  while [ "$("${ADB[@]}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do
    now="$(date +%s)"
    if [ $((now - attempt_start)) -ge 180 ]; then
      fail "$label returned over ADB but Android did not finish booting within 3 minutes"
    fi
    sleep 2
  done
  sleep 8
  echo "$label reboot complete."
}

query_firmware_versions() {
  local deadline line clean bes mtk
  "${ADB[@]}" logcat -c >/dev/null 2>&1 || return 1
  "${ADB[@]}" shell am broadcast \
    -a com.mentra.asg_client.ACTION_SEND_COMMAND \
    --es json '{"type":"request_version","mId":424242}' \
    -n "$COMMAND_RECEIVER" >/dev/null 2>&1 || return 1

  deadline=$((SECONDS + 20))
  while [ "$SECONDS" -lt "$deadline" ]; do
    line="$("${ADB[@]}" logcat -d 2>/dev/null | tr -d '\r' | grep 'version_info_3' | tail -n 1 || true)"
    if [ -n "$line" ]; then
      clean="$(printf '%s\n' "$line" | tr -d '\\')"
      bes="$(printf '%s\n' "$clean" | sed -n 's/.*"bes_fw_version":"\([^"]*\)".*/\1/p')"
      mtk="$(printf '%s\n' "$clean" | sed -n 's/.*"mtk_fw_version":"\([^"]*\)".*/\1/p')"
      if [ -n "$bes" ]; then
        printf '%s|%s\n' "$bes" "$mtk"
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

wait_for_bes_success() {
  local target_version="$1"
  local deadline logs versions bes
  deadline=$((SECONDS + 420))

  echo "Waiting for BES firmware transfer and apply (up to 7 minutes)..."
  while [ "$SECONDS" -lt "$deadline" ]; do
    adb_online || fail "ADB disconnected during the BES transfer"
    logs="$("${ADB[@]}" logcat -d 2>/dev/null | tail -n 500 || true)"
    if printf '%s\n' "$logs" | grep -Fq 'BES firmware update SUCCESS! BES will reboot.'; then
      echo "ASG 36 reports that BES accepted the firmware and is rebooting."
      break
    fi
    if printf '%s\n' "$logs" | grep -Eq 'Apply firmware error|WHOLE CRC32 CHECK FAILED|BES OTA authorization DENIED|Debug BES OTA dispatch failed|BES OTA failed to start|BesOtaManager not initialized'; then
      fail "BES update failed; inspect adb logcat for the reported OTA error"
    fi
    sleep 3
  done
  if [ "$SECONDS" -ge "$deadline" ]; then
    fail "Timed out waiting for BES to accept the firmware"
  fi

  sleep 25
  deadline=$((SECONDS + 120))
  while [ "$SECONDS" -lt "$deadline" ]; do
    versions="$(query_firmware_versions || true)"
    bes="${versions%%|*}"
    if [ -n "$bes" ] && version_at_least "$bes" "$target_version"; then
      echo "Verified BES firmware $bes."
      return 0
    fi
    sleep 5
  done
  fail "BES applied, but target version $target_version could not be verified"
}

build_mtk_plan() {
  local manifest="$1"
  local initial="$2"
  local plan="$3"
  local cursor="$initial"
  local step=0 count row end url sha filename suffix max_suffix candidate_suffix

  : > "$plan"
  while true; do
    count="$(jq --arg current "$cursor" '[.mtk_patches[] | select(.start_firmware == $current)] | length' "$manifest")"
    if [ "$count" -gt 1 ]; then
      fail "Staging manifest has multiple MTK patches starting at $cursor"
    fi
    if [ "$count" -eq 0 ]; then
      if jq -e --arg current "$cursor" 'any(.mtk_patches[]; .end_firmware == $current)' "$manifest" >/dev/null; then
        echo "MTK is already at manifest terminal $cursor."
        return 0
      fi

      suffix="$(firmware_suffix "$cursor")"
      max_suffix=""
      while IFS= read -r candidate_suffix; do
        if [ -z "$max_suffix" ] || version_at_least "$candidate_suffix" "$max_suffix"; then
          max_suffix="$candidate_suffix"
        fi
      done < <(jq -r '.mtk_patches[].end_firmware' "$manifest" | sed -nE 's/.*_([0-9]{8}(\.[0-9]+)?)$/\1/p')
      if [ -n "$suffix" ] && [ -n "$max_suffix" ] && version_at_least "$suffix" "$max_suffix"; then
        echo "MTK $cursor is newer than the staging manifest terminal; refusing to downgrade it."
        return 0
      fi
      fail "No MTK patch path from device firmware $cursor in the staging manifest"
    fi

    if grep -Fqx -- "$cursor" "${plan}.visited" 2>/dev/null; then
      fail "MTK patch graph contains a cycle at $cursor"
    fi
    printf '%s\n' "$cursor" >> "${plan}.visited"
    row="$(jq -r --arg current "$cursor" '.mtk_patches[] | select(.start_firmware == $current) | [.end_firmware, .url, .sha256] | @tsv' "$manifest")"
    IFS=$'\t' read -r end url sha <<< "$row"
    sha="$(printf '%s\n' "$sha" | tr '[:upper:]' '[:lower:]')"
    step=$((step + 1))
    filename="$(basename "${url%%\?*}")"
    if ! [[ "$filename" =~ _[0-9]{8}(\.[0-9]+)?_[0-9]{8}(\.[0-9]+)?\.zip$ ]]; then
      fail "MTK patch URL has an unsupported filename: $filename"
    fi
    mkdir -p "$WORK_DIR/mtk-$step"
    download_verified "MTK patch $cursor -> $end" "$url" "$sha" "" "$WORK_DIR/mtk-$step/$filename"
    printf '%s\t%s\t%s\n' "$cursor" "$end" "$WORK_DIR/mtk-$step/$filename" >> "$plan"
    cursor="$end"
  done
}

recover_orphaned_legacy_stock_files

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mentra-dev-ota.XXXXXX")"
MANIFEST_PATH="$WORK_DIR/staging-manifest.json"
BRIDGE_APK_PATH="$WORK_DIR/asg-36-bridge.apk"
TARGET_APK_PATH="$WORK_DIR/staging-asg.apk"
BES_PATH="$WORK_DIR/bes-firmware.bin"
MTK_PLAN_PATH="$WORK_DIR/mtk-plan.tsv"

echo ""
echo "=== Preparing Mentra Live Stock Firmware ==="
echo "Manifest: $MANIFEST_URL"
echo "The manifest will be fetched once and pinned for this run."
echo ""

curl --fail --location --retry 3 --retry-all-errors --output "$MANIFEST_PATH" "$MANIFEST_URL"
"$REPO_DIR/.github/scripts/validate-asg-ota-manifest.sh" "$MANIFEST_PATH"
jq -e '
  .mtk_patches
  | all(.[];
      (.start_firmware | type == "string" and test("^MentraLive_[0-9]{8}(\\.[0-9]+)?$"))
      and (.end_firmware | type == "string" and test("^MentraLive_[0-9]{8}(\\.[0-9]+)?$"))
      and (.url | type == "string" and test("^https://[^[:space:]]+$"))
      and (.sha256 | type == "string" and test("^[0-9a-fA-F]{64}$")))
' "$MANIFEST_PATH" >/dev/null || fail "Staging manifest contains invalid MTK patch metadata"

TARGET_VERSION_CODE="$(jq -er '.apps["com.mentra.asg_client"].versionCode' "$MANIFEST_PATH")"
TARGET_VERSION_NAME="$(jq -er '.apps["com.mentra.asg_client"].versionName' "$MANIFEST_PATH")"
TARGET_APK_URL="$(jq -er '.apps["com.mentra.asg_client"].apkUrl' "$MANIFEST_PATH")"
TARGET_APK_SIZE="$(jq -er '.apps["com.mentra.asg_client"].apkSize' "$MANIFEST_PATH")"
TARGET_APK_SHA256="$(jq -er '.apps["com.mentra.asg_client"].sha256 | ascii_downcase' "$MANIFEST_PATH")"
BES_VERSION="$(jq -er '.bes_firmware.version' "$MANIFEST_PATH")"
BES_URL="$(jq -er '.bes_firmware.url' "$MANIFEST_PATH")"
BES_SHA256="$(jq -er '.bes_firmware.sha256 | ascii_downcase' "$MANIFEST_PATH")"
INITIAL_MTK="$("${ADB[@]}" shell getprop ro.custom.ota.version 2>/dev/null | tr -d '\r\n')"
[ -n "$INITIAL_MTK" ] || fail "Could not read ro.custom.ota.version from Mentra Live"
[[ "$INITIAL_MTK" =~ ^MentraLive_[0-9]{8}(\.[0-9]+)?$ ]] \
  || fail "Unsupported MTK firmware version reported by device: $INITIAL_MTK"

echo "Run snapshot:"
echo "  ASG: $TARGET_VERSION_NAME ($TARGET_VERSION_CODE)"
echo "  BES: $BES_VERSION"
echo "  MTK: $INITIAL_MTK"
echo ""

# Finish every download and integrity check before replacing any package or
# beginning any firmware transition.
download_verified "ASG 36 bridge" "$BRIDGE_APK_URL" "$BRIDGE_APK_SHA256" "$BRIDGE_APK_SIZE" "$BRIDGE_APK_PATH"
download_verified "staging ASG Client" "$TARGET_APK_URL" "$TARGET_APK_SHA256" "$TARGET_APK_SIZE" "$TARGET_APK_PATH"
download_verified "BES firmware $BES_VERSION" "$BES_URL" "$BES_SHA256" "" "$BES_PATH"
build_mtk_plan "$MANIFEST_PATH" "$INITIAL_MTK" "$MTK_PLAN_PATH"

echo ""
echo "All OTA artifacts are downloaded and verified."
echo ""

DEVICE_MUTATED=true
"${ADB[@]}" shell am force-stop "$DEV_PKG" >/dev/null 2>&1 || true
"${ADB[@]}" shell pm disable-user --user 0 "$DEV_PKG" >/dev/null 2>&1 || true
"${ADB[@]}" shell am force-stop "$RECOVERY_PKG" >/dev/null 2>&1 || true
"${ADB[@]}" shell pm disable-user --user 0 "$RECOVERY_PKG" >/dev/null 2>&1 || true
"${ADB[@]}" shell am force-stop "$LEGACY_UPDATER_PKG" >/dev/null 2>&1 || true
"${ADB[@]}" shell pm disable-user --user 0 "$LEGACY_UPDATER_PKG" >/dev/null 2>&1 || true
enable_stock_runtime

echo "=== Installing ASG 36 BES bridge ==="
"${ADB[@]}" install -r "$BRIDGE_APK_PATH"
INSTALLED_VERSION_CODE="$(package_version_code "$STOCK_PKG")"
[ "$INSTALLED_VERSION_CODE" = "$BRIDGE_VERSION_CODE" ] \
  || fail "ASG 36 bridge installation did not produce versionCode $BRIDGE_VERSION_CODE"
"${ADB[@]}" shell am start -n "$STOCK_COMPONENT" >/dev/null
sleep 20

VERSIONS="$(query_firmware_versions || true)"
CURRENT_BES="${VERSIONS%%|*}"
if [ -n "$CURRENT_BES" ]; then
  echo "Detected BES firmware $CURRENT_BES."
fi

if [ -n "$CURRENT_BES" ] && version_at_least "$CURRENT_BES" "$BES_VERSION"; then
  if [ "$CURRENT_BES" = "$BES_VERSION" ]; then
    echo "BES is already at the staging target."
  else
    echo "BES $CURRENT_BES is newer than staging target $BES_VERSION; refusing to downgrade it."
  fi
else
  echo "=== Updating BES to $BES_VERSION through ASG 36 ==="
  ANDROID_SERIAL="$SERIAL" "$SCRIPT_DIR/test-bes-ota.sh" "$BES_PATH" "$BES_VERSION" --no-follow
  wait_for_bes_success "$BES_VERSION"
fi

echo ""
echo "=== Replacing bridge with staging ASG Client ==="
"${ADB[@]}" shell am force-stop "$STOCK_PKG" >/dev/null 2>&1 || true
preserve_legacy_stock_files
"${ADB[@]}" uninstall "$STOCK_PKG" >/dev/null \
  || fail "Could not remove the ASG 36 update layer"
"${ADB[@]}" shell cmd package install-existing "$STOCK_PKG" >/dev/null 2>&1 || true
"${ADB[@]}" shell pm disable-user --user 0 "$STOCK_PKG" >/dev/null 2>&1 || true
"${ADB[@]}" install -r "$TARGET_APK_PATH"
INSTALLED_VERSION_CODE="$(package_version_code "$STOCK_PKG")"
[ "$INSTALLED_VERSION_CODE" = "$TARGET_VERSION_CODE" ] \
  || fail "Staging ASG install expected versionCode $TARGET_VERSION_CODE, got ${INSTALLED_VERSION_CODE:-unknown}"
restore_legacy_stock_files \
  || fail "Staging ASG installed, but preserved legacy stock data could not be restored"
enable_stock_runtime
sleep 20

if [ -s "$MTK_PLAN_PATH" ]; then
  while IFS=$'\t' read -r PATCH_START PATCH_END PATCH_PATH; do
    CURRENT_MTK="$("${ADB[@]}" shell getprop ro.custom.ota.version 2>/dev/null | tr -d '\r\n')"
    [ "$CURRENT_MTK" = "$PATCH_START" ] \
      || fail "MTK changed unexpectedly: patch requires $PATCH_START, device reports $CURRENT_MTK"

    echo ""
    echo "=== Updating MTK: $PATCH_START -> $PATCH_END ==="
    BOOT_ID_BEFORE="$("${ADB[@]}" shell cat /proc/sys/kernel/random/boot_id 2>/dev/null | tr -d '\r\n')"
    ANDROID_SERIAL="$SERIAL" "$SCRIPT_DIR/test-mtk-ota.sh" "$PATCH_PATH" \
      --start-firmware "$PATCH_START" \
      --end-firmware "$PATCH_END"
    wait_for_boot_after_reboot "MTK" "$BOOT_ID_BEFORE"

    CURRENT_MTK="$("${ADB[@]}" shell getprop ro.custom.ota.version 2>/dev/null | tr -d '\r\n')"
    [ "$CURRENT_MTK" = "$PATCH_END" ] \
      || fail "MTK rebooted but expected $PATCH_END, got ${CURRENT_MTK:-unknown}"
    enable_stock_runtime
    sleep 10
  done < "$MTK_PLAN_PATH"
fi

FINAL_MTK="$("${ADB[@]}" shell getprop ro.custom.ota.version 2>/dev/null | tr -d '\r\n')"
echo ""
echo "Stock firmware baseline is ready:"
echo "  ASG: $TARGET_VERSION_NAME ($TARGET_VERSION_CODE)"
echo "  BES: $BES_VERSION or newer"
echo "  MTK: $FINAL_MTK"

if [ "$RESUME_THIRDPARTY" = true ]; then
  echo ""
  echo "=== Returning to the installed third-party ASG Client ==="
  enable_thirdparty_runtime
  echo "$DEV_PKG is active again; its APK and app data were preserved."
fi

SUCCESS=true
