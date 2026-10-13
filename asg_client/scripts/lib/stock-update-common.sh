#!/bin/bash
# Shared Mentra Live stock-update phases. Source this file; do not execute it.
# The manifest is downloaded once. Every later artifact comes from that snapshot.
# Order is pinned ASG, then MTK, then BES. The ASG 36 bridge is used only after
# MTK, and only when the pinned stock client cannot read BES.

STOCK_UPDATE_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$STOCK_UPDATE_COMMON_DIR/.." && pwd)"
ASG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$ASG_DIR/.." && pwd)"

DEFAULT_MANIFEST_URL="https://github.com/Mentra-Community/MentraOS/releases/download/staging-builds/staging_live_version.json"
MANIFEST_URL="${MANIFEST_URL:-${ASG_DEV_OTA_MANIFEST_URL:-$DEFAULT_MANIFEST_URL}}"
RESUME_THIRDPARTY="${RESUME_THIRDPARTY:-false}"
STOCK_UPDATE_MODE="${STOCK_UPDATE_MODE:-developer}"

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
PRESERVED_STOCK_APK_DEVICE_PATH="/storage/emulated/0/asg/dev_setup_newer_stock.apk"
PRESERVED_STOCK_STATE_PATH="/storage/emulated/0/asg/dev_setup_newer_stock.state"

WORK_DIR=""
DEVICE_MUTATED=false
SUCCESS=false
LEGACY_STOCK_BACKUP=""
BRIDGE_ACTIVE=false
PRESERVED_STOCK_APK_PATH=""
PRESERVED_STOCK_VERSION_CODE=""

fail() {
  echo ""
  echo "ERROR: $1" >&2
  exit 1
}

stock_fail() {
  local code="$1"
  shift
  if [ "${STOCK_UPDATE_MODE:-developer}" != "refurb" ]; then
    code=1
  fi
  echo ""
  echo "ERROR: $*" >&2
  exit "$code"
}

phase() {
  echo ""
  echo "=== $* ==="
  if [ -n "${STOCK_UPDATE_PHASE_LOG:-}" ]; then
    printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$STOCK_UPDATE_PHASE_LOG"
  fi
}

require_commands() {
  local command_name
  for command_name in adb curl jq python3; do
    command -v "$command_name" >/dev/null 2>&1 || fail "Required command not found: $command_name"
  done
}

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

  if [ -z "$expected_size" ]; then
    expected_size="$(curl --fail --silent --location --head "$url" \
      | awk 'BEGIN{IGNORECASE=1} /^content-length:/ {gsub(/\r/,""); value=$2} END{print value}')"
    if [ -n "$expected_size" ]; then
      echo "Pinned Content-Length $expected_size for $label before download."
    else
      echo "Server sent no Content-Length for $label. The digest is checked, then the downloaded byte count is pinned."
    fi
  fi

  echo "Downloading $label..."
  curl --fail --location --retry 3 --retry-all-errors --output "${destination}.part" "$url"
  mv "${destination}.part" "$destination"

  actual_sha="$(sha256_file "$destination")"
  if [ "$actual_sha" != "$expected_sha" ]; then
    stock_fail 12 "$label SHA-256 mismatch (expected $expected_sha, got $actual_sha)"
  fi

  actual_size="$(wc -c < "$destination" | tr -d ' ')"
  if [ -z "$expected_size" ]; then
    expected_size="$actual_size"
  fi
  if [ "$actual_size" != "$expected_size" ]; then
    stock_fail 12 "$label size mismatch (expected $expected_size, got $actual_size)"
  fi
  printf '%s\t%s\t%s\n' "$label" "$expected_sha" "$expected_size" >> "${WORK_DIR}/artifact-sizes.tsv"
  echo "Verified $label ($actual_size bytes)."
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

valid_bes_version() {
  awk -F. 'NF != 4 { exit 1 } {
    for (x = 1; x <= 4; x++) {
      if ($x !~ /^[0-9][0-9]?[0-9]?$/ || $x + 0 > 255) exit 1;
    }
    exit 0;
  }' <<< "$1"
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

package_version_name() {
  "${ADB[@]}" shell dumpsys package "$1" 2>/dev/null \
    | tr -d '\r' \
    | sed -n 's/.*versionName=\([^ ]*\).*/\1/p' \
    | head -n 1
}

asg_prerelease_name() {
  [[ "$1" =~ -(dev|beta)(\.[0-9]+)?$ ]]
}

device_sha256() {
  "${ADB[@]}" shell sha256sum "$1" 2>/dev/null | awk '{print $1}' | tr -d '\r'
}

clear_preserved_stock_update() {
  "${ADB[@]}" shell rm -f \
    "$PRESERVED_STOCK_APK_DEVICE_PATH" "$PRESERVED_STOCK_STATE_PATH" >/dev/null 2>&1 || true
  PRESERVED_STOCK_APK_PATH=""
  PRESERVED_STOCK_VERSION_CODE=""
}

load_preserved_stock_update() {
  local presence state expected_sha actual_sha
  local apk_exists=false state_exists=false

  if ! presence="$("${ADB[@]}" shell \
    "if [ -f '$PRESERVED_STOCK_APK_DEVICE_PATH' ]; then printf 1; else printf 0; fi; if [ -f '$PRESERVED_STOCK_STATE_PATH' ]; then printf 1; else printf 0; fi" \
    2>/dev/null | tr -d '\r\n')"; then
    echo "ADB disconnected while checking preserved stock-ASG state." >&2
    return 1
  fi
  case "$presence" in
    00) ;;
    01) state_exists=true ;;
    10) apk_exists=true ;;
    11)
      apk_exists=true
      state_exists=true
      ;;
    *)
      echo "Could not determine preserved stock-ASG state on the device." >&2
      return 1
      ;;
  esac
  if [ "$apk_exists" = false ] && [ "$state_exists" = false ]; then
    return 0
  fi
  if [ "$apk_exists" != true ] || [ "$state_exists" != true ]; then
    echo "Incomplete preserved stock-ASG update metadata on the device." >&2
    return 1
  fi

  state="$("${ADB[@]}" shell cat "$PRESERVED_STOCK_STATE_PATH" 2>/dev/null | tr -d '\r\n')"
  IFS=: read -r PRESERVED_STOCK_VERSION_CODE expected_sha <<< "$state"
  if ! [[ "$PRESERVED_STOCK_VERSION_CODE" =~ ^[0-9]+$ ]] \
    || ! [[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Invalid preserved stock-ASG update metadata." >&2
    return 1
  fi
  if [ "$PRESERVED_STOCK_VERSION_CODE" -le "$TARGET_VERSION_CODE" ]; then
    echo "Discarding preserved stock ASG $PRESERVED_STOCK_VERSION_CODE because manifest target $TARGET_VERSION_CODE is at least as new."
    clear_preserved_stock_update
    return 0
  fi

  PRESERVED_STOCK_APK_PATH="$WORK_DIR/preserved-newer-stock.apk"
  "${ADB[@]}" pull "$PRESERVED_STOCK_APK_DEVICE_PATH" "$PRESERVED_STOCK_APK_PATH" >/dev/null \
    || return 1
  actual_sha="$(sha256_file "$PRESERVED_STOCK_APK_PATH")"
  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "Preserved stock-ASG update SHA-256 mismatch." >&2
    return 1
  fi
  echo "Recovered stock ASG $PRESERVED_STOCK_VERSION_CODE preserved by an interrupted firmware update."
}

preserve_newer_stock_update() {
  local installed_version installed_name package_path package_path_count device_sha host_sha
  installed_version="$(package_version_code "$STOCK_PKG")"
  installed_name="$(package_version_name "$STOCK_PKG")"
  if ! [[ "$installed_version" =~ ^[0-9]+$ ]] \
    || [ "$installed_version" -le "$TARGET_VERSION_CODE" ] \
    || asg_prerelease_name "$installed_name"; then
    return 0
  fi

  package_path="$("${ADB[@]}" shell pm path "$STOCK_PKG" 2>/dev/null \
    | tr -d '\r' | sed -n 's/^package://p')"
  package_path_count="$(printf '%s\n' "$package_path" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$package_path_count" -ne 1 ]; then
    echo "Newer stock ASG uses $package_path_count APK files; refusing an update that cannot restore it exactly." >&2
    return 1
  fi
  case "$package_path" in
    /data/app/*.apk) ;;
    *)
      echo "Newer stock ASG $installed_version is built into the system image and will be retained."
      return 0
      ;;
  esac

  clear_preserved_stock_update
  PRESERVED_STOCK_APK_PATH="$WORK_DIR/preserved-newer-stock.apk"
  echo "Preserving newer installed stock ASG $installed_version during firmware maintenance..."
  "${ADB[@]}" pull "$package_path" "$PRESERVED_STOCK_APK_PATH" >/dev/null || return 1
  host_sha="$(sha256_file "$PRESERVED_STOCK_APK_PATH")"
  "${ADB[@]}" shell mkdir -p /storage/emulated/0/asg || return 1
  "${ADB[@]}" push "$PRESERVED_STOCK_APK_PATH" "$PRESERVED_STOCK_APK_DEVICE_PATH" >/dev/null \
    || return 1
  device_sha="$(device_sha256 "$PRESERVED_STOCK_APK_DEVICE_PATH")"
  [ "$device_sha" = "$host_sha" ] || return 1
  "${ADB[@]}" shell \
    "printf '%s' '$installed_version:$host_sha' > '$PRESERVED_STOCK_STATE_PATH'" \
    || return 1
  PRESERVED_STOCK_VERSION_CODE="$installed_version"
  echo "Stored a verified recovery copy at $PRESERVED_STOCK_APK_DEVICE_PATH."
}

# Stop and disable the launchers that compete for HOME before any firmware
# mutation. Left enabled, the third-party launcher, com.mentra.recovery, or the
# legacy OTA updater can retake HOME or interrupt the BES window while stock
# ASG, MTK, and the compatibility bridge run.
disable_competing_launchers() {
  "${ADB[@]}" shell am force-stop "$DEV_PKG" >/dev/null 2>&1 || true
  "${ADB[@]}" shell pm disable-user --user 0 "$DEV_PKG" >/dev/null 2>&1 || true
  "${ADB[@]}" shell am force-stop "$RECOVERY_PKG" >/dev/null 2>&1 || true
  "${ADB[@]}" shell pm disable-user --user 0 "$RECOVERY_PKG" >/dev/null 2>&1 || true
  "${ADB[@]}" shell am force-stop "$LEGACY_UPDATER_PKG" >/dev/null 2>&1 || true
  "${ADB[@]}" shell pm disable-user --user 0 "$LEGACY_UPDATER_PKG" >/dev/null 2>&1 || true
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
  if ! [[ "$entry_count" =~ ^[0-9]+$ ]]; then
    echo "Could not inventory legacy stock data before uninstall." >&2
    return 1
  fi

  if "${ADB[@]}" shell test -e "$LEGACY_STOCK_BACKUP_PATH"; then
    LEGACY_STOCK_BACKUP="$LEGACY_STOCK_BACKUP_PATH"
    if [ "$entry_count" -eq 0 ]; then
      echo "Reusing preserved legacy stock data from $LEGACY_STOCK_BACKUP_PATH."
      return 0
    fi
    echo "Both preserved and live legacy stock data exist; refusing to overwrite either tree." >&2
    return 1
  fi
  if [ "$entry_count" -eq 0 ]; then
    return 0
  fi
  LEGACY_STOCK_BACKUP="$LEGACY_STOCK_BACKUP_PATH"
  echo "Preserving $entry_count legacy stock-data entries during firmware maintenance..."
  "${ADB[@]}" shell mkdir -p /storage/emulated/0/asg || return 1
  "${ADB[@]}" shell mv "$LEGACY_STOCK_FILES" "$LEGACY_STOCK_BACKUP" \
    || return 1
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

replace_bridge_with_target_stock() {
  local installed_version
  if [ "$BRIDGE_ACTIVE" != true ]; then
    return 0
  fi

  "${ADB[@]}" shell am force-stop "$STOCK_PKG" >/dev/null 2>&1 || true
  preserve_legacy_stock_files || return 1
  "${ADB[@]}" uninstall "$STOCK_PKG" >/dev/null || return 1
  "${ADB[@]}" shell cmd package install-existing "$STOCK_PKG" >/dev/null 2>&1 || true
  installed_version="$(package_version_code "$STOCK_PKG")"
  if [ -n "$PRESERVED_STOCK_APK_PATH" ]; then
    if [[ "$installed_version" =~ ^[0-9]+$ ]] \
      && [ "$installed_version" -ge "$PRESERVED_STOCK_VERSION_CODE" ]; then
      echo "Built-in stock ASG $installed_version is at least as new as preserved update $PRESERVED_STOCK_VERSION_CODE; retaining it."
    else
      "${ADB[@]}" install -r "$PRESERVED_STOCK_APK_PATH" >/dev/null || return 1
      installed_version="$(package_version_code "$STOCK_PKG")"
      [ "$installed_version" = "$PRESERVED_STOCK_VERSION_CODE" ] || return 1
      echo "Restored preserved stock ASG $installed_version."
    fi
  elif [[ "$installed_version" =~ ^[0-9]+$ ]] \
    && [ "$installed_version" -gt "$TARGET_VERSION_CODE" ]; then
    echo "Built-in stock ASG $installed_version is newer than staging target $TARGET_VERSION_CODE; retaining it."
  else
    "${ADB[@]}" shell pm disable-user --user 0 "$STOCK_PKG" >/dev/null 2>&1 || true
    "${ADB[@]}" install -r "$TARGET_APK_PATH" >/dev/null || return 1
    installed_version="$(package_version_code "$STOCK_PKG")"
    [ "$installed_version" = "$TARGET_VERSION_CODE" ] || return 1
  fi
  BRIDGE_ACTIVE=false
  restore_legacy_stock_files || return 1
  clear_preserved_stock_update
}

restore_safe_stock_on_failure() {
  local installed_version
  if [ "$DEVICE_MUTATED" = true ] && adb_online; then
    installed_version="$(package_version_code "$STOCK_PKG" || true)"
    if [ "$installed_version" = "$BRIDGE_VERSION_CODE" ]; then
      BRIDGE_ACTIVE=true
    fi
    echo "Restoring the stock launcher after the failed setup..." >&2
    "${ADB[@]}" shell am force-stop "$DEV_PKG" >/dev/null 2>&1 || true
    "${ADB[@]}" shell pm disable-user --user 0 "$DEV_PKG" >/dev/null 2>&1 || true
    if [ "$BRIDGE_ACTIVE" = true ]; then
      if replace_bridge_with_target_stock; then
        echo "Restored a safe stock ASG after the interrupted update." >&2
      else
        echo "Could not fully restore stock ASG automatically; preserved data remains staged if needed." >&2
      fi
    fi
    restore_legacy_stock_files || true
    if enable_stock_runtime; then
      echo "Stock launcher restored." >&2
    else
      echo "Could not fully restore stock automatically; run ./scripts/restore-stock.sh." >&2
    fi
    "${ADB[@]}" shell pm enable "$RECOVERY_PKG" >/dev/null 2>&1 || true
    "${ADB[@]}" shell pm enable "$LEGACY_UPDATER_PKG" >/dev/null 2>&1 || true
  elif [ "$DEVICE_MUTATED" = true ]; then
    if [ "$BRIDGE_ACTIVE" = true ]; then
      echo "Firmware maintenance may be incomplete. Reconnect ADB and rerun this updater; it will restore a safe stock ASG first." >&2
    fi
    if [ -n "$LEGACY_STOCK_BACKUP" ]; then
      echo "Legacy stock data remains safe at $LEGACY_STOCK_BACKUP once ADB reconnects." >&2
    fi
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$SUCCESS" != true ]; then
    restore_safe_stock_on_failure
  fi
  if declare -F stock_update_on_exit >/dev/null; then
    stock_update_on_exit "$status" || true
  fi
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ] && [ "${STOCK_UPDATE_KEEP_WORK:-}" != "1" ]; then
    rm -rf -- "$WORK_DIR"
  fi
  exit "$status"
}

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
  "${ADB[@]}" shell "am broadcast -a com.mentra.asg_client.ACTION_SEND_COMMAND --es json '{\"type\":\"request_version\",\"mId\":424242}' -n $COMMAND_RECEIVER" >/dev/null 2>&1 || return 1

  deadline=$((SECONDS + ${STOCK_UPDATE_VERSION_WAIT_SECONDS:-20}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    line="$("${ADB[@]}" logcat -d 2>/dev/null | tr -d '\r' | grep 'bes_fw_version' | tail -n 1 || true)"
    if [ -n "$line" ]; then
      clean="$(printf '%s\n' "$line" | tr -d '\\')"
      bes="$(printf '%s\n' "$clean" | sed -n 's/.*"bes_fw_version":"\([^"]*\)".*/\1/p')"
      mtk="$(printf '%s\n' "$clean" | sed -n 's/.*"mtk_fw_version":"\([^"]*\)".*/\1/p')"
      if [ -n "$bes" ] && valid_bes_version "$bes"; then
        printf '%s|%s\n' "$bes" "$mtk"
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

return_bes_to_rendezvous_before_bridge() {
  local request_id deadline logs versions bes installed_version
  request_id="devsetup_$$_$RANDOM"

  echo "=== Preparing BES for firmware maintenance ==="
  installed_version="$(package_version_code "$STOCK_PKG")"
  if [[ "$installed_version" =~ ^[0-9]+$ ]] \
    && [ "$installed_version" -gt "$TARGET_VERSION_CODE" ]; then
    echo "Installed stock ASG $installed_version is newer than staging target $TARGET_VERSION_CODE; using it as the transition controller."
  else
    echo "Installing the manifest-pinned stock ASG as the transition controller..."
    "${ADB[@]}" install -r "$TARGET_APK_PATH"
    installed_version="$(package_version_code "$STOCK_PKG")"
    [ "$installed_version" = "$TARGET_VERSION_CODE" ] \
      || fail "Rendezvous controller expected versionCode $TARGET_VERSION_CODE, got ${installed_version:-unknown}"
  fi
  enable_stock_runtime
  sleep 20

  versions="$(query_firmware_versions || true)"
  bes="${versions%%|*}"
  if [ -z "$bes" ] || ! valid_bes_version "$bes"; then
    # Current ASG scans both supported bauds. No proof normally identifies the
    # factory BES generation that needs ASG 36's legacy protocol; stop the
    # probe client and let the bridge attempt its fail-closed version query.
    "${ADB[@]}" shell am force-stop "$STOCK_PKG" >/dev/null 2>&1 || true
    sleep 2
    echo "Current stock ASG found no BES link; continuing with compatibility recovery."
    return 0
  fi
  echo "Current stock ASG found BES $bes before firmware maintenance."

  "${ADB[@]}" logcat -c >/dev/null 2>&1 || true
  "${ADB[@]}" shell "am broadcast -a com.mentra.asg_client.ACTION_SEND_COMMAND --es json '{\"type\":\"reboot_bes_for_mtk_flash\",\"mId\":424243,\"request_id\":\"$request_id\"}' -n $COMMAND_RECEIVER" >/dev/null \
    || fail "Could not dispatch the BES rendezvous reset"

  deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    logs="$("${ADB[@]}" logcat -d 2>/dev/null | grep -F "MTK_FLASH_BES_RESET request_id=$request_id" || true)"
    if printf '%s\n' "$logs" | grep -Fq 'uart_write=true'; then
      # BES is now resetting to 460800. Stop the current client before it can
      # rediscover the chip and renegotiate fast baud ahead of ASG 36.
      "${ADB[@]}" shell am force-stop "$STOCK_PKG" >/dev/null 2>&1 || true
      sleep 5
      echo "BES reset completed; compatibility update is ready."
      return 0
    fi
    if printf '%s\n' "$logs" | grep -Eq 'uart_write=false|queued=false|failed'; then
      fail "Current stock ASG could not write the BES rendezvous reset"
    fi
    sleep 1
  done
  fail "Timed out waiting for proof that the BES rendezvous reset reached UART"
}

wait_for_bes_success() {
  local target_version="$1"
  local deadline logs versions bes
  local budget="${STOCK_UPDATE_BES_WAIT_SECONDS:-420}"
  local accepted=false
  deadline=$((SECONDS + budget))

  echo "Waiting for BES firmware transfer and apply (up to 7 minutes)..."
  while [ "$SECONDS" -lt "$deadline" ]; do
    adb_online || fail "ADB disconnected during the BES transfer"
    logs="$("${ADB[@]}" logcat -d 2>/dev/null | tail -n 500 || true)"
    if printf '%s\n' "$logs" | grep -Fq 'BES firmware update SUCCESS! BES will reboot.'; then
      accepted=true
      echo "BES accepted the firmware and is rebooting."
      break
    fi
    if printf '%s\n' "$logs" | grep -Eq 'Apply firmware error|WHOLE CRC32 CHECK FAILED|BES OTA authorization DENIED|Debug BES OTA dispatch failed|BES OTA failed to start|BesOtaManager not initialized'; then
      fail "BES update failed; inspect adb logcat for the reported OTA error"
    fi
    sleep 3
  done
  if [ "$accepted" != true ]; then
    fail "Timed out waiting for BES to accept the firmware"
  fi

  sleep 25
  deadline=$((SECONDS + budget))
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
  local file_start_suffix file_end_suffix start_suffix end_suffix

  : > "$plan"
  while true; do
    count="$(jq --arg current "$cursor" '[.mtk_patches[] | select(.start_firmware == $current)] | length' "$manifest")"
    if [ "$count" -gt 1 ]; then
      fail "Staging manifest has multiple MTK patches starting at $cursor"
    fi
    if [ "$count" -eq 0 ]; then
      if jq -e --arg current "$cursor" 'any(.mtk_patches[]; .end_firmware == $current)' "$manifest" >/dev/null; then
        if [ -s "$plan" ]; then
          echo "MTK patch chain ends at $cursor."
          MTK_PLAN_RESULT="upgrade"
        else
          echo "MTK is already at manifest terminal $cursor."
          MTK_PLAN_RESULT="current"
        fi
        return 0
      fi

      suffix="$(firmware_suffix "$cursor")"
      max_suffix=""
      while IFS= read -r candidate_suffix; do
        if [ -z "$max_suffix" ] || version_at_least "$candidate_suffix" "$max_suffix"; then
          max_suffix="$candidate_suffix"
        fi
      done < <(jq -r '[(.mtk_patches[].end_firmware), (.mtk_full_ota.end_firmware // empty)] | .[]' "$manifest" \
        | sed -nE 's/.*_([0-9]{8}(\.[0-9]+)?)$/\1/p')
      if [ -n "$suffix" ] && [ -n "$max_suffix" ] && version_at_least "$suffix" "$max_suffix" \
        && [ "$suffix" != "$max_suffix" ]; then
        echo "MTK $cursor is newer than the pinned terminal; refusing to downgrade it."
        MTK_PLAN_RESULT="newer"
        return 0
      fi
      if [ -n "$suffix" ] && [ "$suffix" = "$max_suffix" ]; then
        echo "MTK is already at the pinned terminal $cursor."
        MTK_PLAN_RESULT="current"
        return 0
      fi

      local full_end full_url full_sha full_size full_path full_suffix
      full_end="$(jq -r '.mtk_full_ota.end_firmware // empty' "$manifest")"
      full_url="$(jq -r '.mtk_full_ota.url // empty' "$manifest")"
      full_sha="$(jq -r '.mtk_full_ota.sha256 // empty' "$manifest" | tr '[:upper:]' '[:lower:]')"
      full_size="$(jq -r '.mtk_full_ota.size // empty' "$manifest")"
      full_suffix="$(firmware_suffix "$full_end")"
      if [ -z "$full_end" ] || [ -z "$full_url" ] || [ -z "$full_sha" ] \
        || [ -z "$full_suffix" ] || ! version_at_least "$full_suffix" "$suffix" \
        || [ "$full_suffix" = "$suffix" ]; then
        fail "No MTK patch path from device firmware $cursor in the pinned manifest"
      fi
      echo "No incremental MTK patch from $cursor; checking the pinned full image for $full_end."
      mkdir -p "$WORK_DIR/mtk-full"
      full_path="$WORK_DIR/mtk-full/$(basename "${full_url%%\?*}")"
      download_verified "MTK full image $cursor -> $full_end" "$full_url" "$full_sha" "$full_size" "$full_path"
      if ! python3 "$SCRIPT_DIR/mtk-ota-manifest.py" "$full_path" --full \
        --device-version "$cursor" --end-firmware "$full_end" >/dev/null; then
        stock_fail 12 "Pinned full MTK image is not a non-wiping upgrade from $cursor to $full_end"
      fi
      printf 'full\t%s\t%s\t%s\n' "$cursor" "$full_end" "$full_path" >> "$plan"
      MTK_PLAN_RESULT="full"
      return 0
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
    if [[ "$filename" =~ _([0-9]{8}(\.[0-9]+)?)_([0-9]{8}(\.[0-9]+)?)\.zip$ ]]; then
      file_start_suffix="${BASH_REMATCH[1]}"
      file_end_suffix="${BASH_REMATCH[3]}"
    else
      fail "MTK patch URL has an unsupported filename: $filename"
    fi
    start_suffix="$(firmware_suffix "$cursor")"
    end_suffix="$(firmware_suffix "$end")"
    if [ "$file_start_suffix" != "$start_suffix" ] || [ "$file_end_suffix" != "$end_suffix" ]; then
      fail "MTK patch filename $filename does not match manifest transition $cursor -> $end"
    fi
    mkdir -p "$WORK_DIR/mtk-$step"
    download_verified "MTK patch $cursor -> $end" "$url" "$sha" "" "$WORK_DIR/mtk-$step/$filename"
    printf 'patch\t%s\t%s\t%s\n' "$cursor" "$end" "$WORK_DIR/mtk-$step/$filename" >> "$plan"
    MTK_PLAN_RESULT="upgrade"
    cursor="$end"
  done
}


read_bes_version() {
  local versions
  versions="$(query_firmware_versions || true)"
  printf '%s\n' "${versions%%|*}"
}

install_pinned_asg() {
  phase "Installing pinned stock ASG $TARGET_VERSION_NAME ($TARGET_VERSION_CODE)"
  "${ADB[@]}" install -r -d "$TARGET_APK_PATH"
  local installed
  installed="$(package_version_code "$STOCK_PKG")"
  [ "$installed" = "$TARGET_VERSION_CODE" ] \
    || fail "Pinned ASG expected versionCode $TARGET_VERSION_CODE, got ${installed:-unknown}"
  enable_stock_runtime || fail "Pinned stock ASG installed, but its launcher did not become HOME"
}

decide_asg_action() {
  local code name
  code="$(package_version_code "$STOCK_PKG")"
  name="$(package_version_name "$STOCK_PKG")"
  ASG_BEFORE_CODE="$code"
  ASG_BEFORE_NAME="$name"
  if [ "$code" = "$TARGET_VERSION_CODE" ] && [ "$name" = "$TARGET_VERSION_NAME" ]; then
    ASG_ACTION="skip"
    return 0
  fi
  if asg_prerelease_name "$name"; then
    ASG_ACTION="replace"
    return 0
  fi
  if [[ "$code" =~ ^[0-9]+$ ]] && [ "$code" -gt "$TARGET_VERSION_CODE" ]; then
    ASG_ACTION="retain"
    return 0
  fi
  ASG_ACTION="install"
}

announce_asg_action() {
  case "$ASG_ACTION" in
    skip)
      echo "ASG $ASG_BEFORE_NAME ($ASG_BEFORE_CODE) already matches the pin. Skipping the ASG install."
      ;;
    replace)
      echo "Installed ASG version name ${ASG_BEFORE_NAME:-unknown} is a prerelease. Replacing it with pinned stock ASG $TARGET_VERSION_NAME ($TARGET_VERSION_CODE)."
      ;;
    retain)
      echo "Installed stock ASG ${ASG_BEFORE_NAME:-unknown} ($ASG_BEFORE_CODE) is newer than the pin. Retaining it."
      ;;
    install)
      echo "Installed ASG ${ASG_BEFORE_NAME:-unknown} (${ASG_BEFORE_CODE:-unknown}) is behind pinned stock ASG $TARGET_VERSION_NAME ($TARGET_VERSION_CODE)."
      ;;
  esac
}

apply_mtk_plan() {
  local kind start end path boot_id current
  [ -s "$MTK_PLAN_PATH" ] || return 0
  while IFS=$'\t' read -r kind start end path; do
    [ -n "$kind" ] || continue
    current="$("${ADB[@]}" shell getprop ro.custom.ota.version 2>/dev/null | tr -d '\r\n')"
    [ "$current" = "$start" ] \
      || fail "MTK changed unexpectedly: step requires $start, device reports ${current:-unknown}"
    phase "Updating MTK $start -> $end"
    boot_id="$("${ADB[@]}" shell cat /proc/sys/kernel/random/boot_id 2>/dev/null | tr -d '\r\n')"
    if [ "$kind" = "full" ]; then
      "${STOCK_UPDATE_MTK_HELPER:-$SCRIPT_DIR/test-mtk-ota.sh}" "$path" --full --end-firmware "$end"
    else
      "${STOCK_UPDATE_MTK_HELPER:-$SCRIPT_DIR/test-mtk-ota.sh}" "$path" --start-firmware "$start" --end-firmware "$end"
    fi
    wait_for_boot_after_reboot "MTK" "$boot_id"
    current="$("${ADB[@]}" shell getprop ro.custom.ota.version 2>/dev/null | tr -d '\r\n')"
    [ "$current" = "$end" ] || fail "MTK rebooted but expected $end, got ${current:-unknown}"
    MTK_TARGET="$end"
    enable_stock_runtime || fail "MTK reached $end, but the stock launcher did not return"
    echo "MTK is now $current."
  done < "$MTK_PLAN_PATH"
}

flash_bes_if_needed() {
  local current="$1"
  if [ "$current" = "$BES_VERSION" ]; then
    echo "BES $current already matches the pin. Skipping the BES update."
    return 0
  fi
  if version_at_least "$current" "$BES_VERSION"; then
    echo "BES $current is newer than pinned $BES_VERSION."
    if [ "$STOCK_UPDATE_MODE" = "refurb" ]; then
      stock_fail 14 "BES $current is newer than pinned $BES_VERSION; refusing to downgrade it"
    fi
    echo "Refusing to downgrade BES."
    return 0
  fi
  phase "Updating BES to $BES_VERSION"
  "${STOCK_UPDATE_BES_HELPER:-$SCRIPT_DIR/test-bes-ota.sh}" "$BES_PATH" "$BES_VERSION" --no-follow
  wait_for_bes_success "$BES_VERSION"
  current="$(read_bes_version)"
  if [ "$STOCK_UPDATE_MODE" = "refurb" ] && [ "$current" != "$BES_VERSION" ]; then
    stock_fail 13 "BES is not pinned: expected $BES_VERSION, fresh read got ${current:-nothing}"
  fi
  [ -n "$current" ] || fail "BES update did not leave a readable version"
  echo "BES read back as $current."
}

run_stock_firmware_update() {
  local manifest_sha=""
  require_commands
  if [ -z "${ADB+x}" ]; then
    # shellcheck disable=SC1091
    source "$REPO_DIR/scripts/lib/glasses-device.sh"
    if [ -n "${ANDROID_SERIAL:-}" ] && [ -z "${ADB_SERIAL:-}" ]; then
      ADB_SERIAL="$ANDROID_SERIAL"
      export ADB_SERIAL
    fi
    resolve_serial
    ADB=(adb -s "$SERIAL")
    export ANDROID_SERIAL="$SERIAL"
  fi
  if [ "$RESUME_THIRDPARTY" = true ] \
    && ! "${ADB[@]}" shell pm path "$DEV_PKG" 2>/dev/null | tr -d '\r' | grep -q '^package:'; then
    fail "$DEV_PKG is not installed; run ./scripts/dev-setup.sh first"
  fi

  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mentra-stock-ota.XXXXXX")"
  MANIFEST_PATH="$WORK_DIR/pinned-manifest.json"
  BRIDGE_APK_PATH="$WORK_DIR/asg-36-bridge.apk"
  TARGET_APK_PATH="$WORK_DIR/pinned-asg.apk"
  BES_PATH="$WORK_DIR/bes-firmware.bin"
  MTK_PLAN_PATH="$WORK_DIR/mtk-plan.tsv"
  : > "$WORK_DIR/artifact-sizes.tsv"
  SUCCESS=false
  DEVICE_MUTATED=false
  BRIDGE_ACTIVE=false
  trap cleanup EXIT

  phase "Preparing Mentra Live stock software"
  if [ -n "${STOCK_UPDATE_TRACK:-}" ]; then
    echo "Track: $STOCK_UPDATE_TRACK"
    echo "Release: ${STOCK_UPDATE_RELEASE:-unknown}"
  fi
  echo "Manifest: $MANIFEST_URL"
  echo "The manifest is fetched once and pinned for this run."

  curl --fail --location --retry 3 --retry-all-errors --output "$MANIFEST_PATH" "$MANIFEST_URL"
  if [ -n "${STOCK_UPDATE_MANIFEST_SHA:-}" ]; then
    manifest_sha="$(sha256_file "$MANIFEST_PATH")"
    [ "$manifest_sha" = "$STOCK_UPDATE_MANIFEST_SHA" ] \
      || stock_fail 12 "Pinned manifest SHA-256 mismatch (expected $STOCK_UPDATE_MANIFEST_SHA, got $manifest_sha)"
    echo "Verified pinned manifest digest."
  fi
  "$REPO_DIR/.github/scripts/validate-asg-ota-manifest.sh" "$MANIFEST_PATH" \
    || stock_fail 12 "Pinned manifest failed validation"

  TARGET_VERSION_CODE="$(jq -er '.apps["com.mentra.asg_client"].versionCode' "$MANIFEST_PATH")"
  TARGET_VERSION_NAME="$(jq -er '.apps["com.mentra.asg_client"].versionName' "$MANIFEST_PATH")"
  TARGET_APK_URL="$(jq -er '.apps["com.mentra.asg_client"].apkUrl' "$MANIFEST_PATH")"
  TARGET_APK_SIZE="$(jq -er '.apps["com.mentra.asg_client"].apkSize' "$MANIFEST_PATH")"
  TARGET_APK_SHA256="$(jq -er '.apps["com.mentra.asg_client"].sha256 | ascii_downcase' "$MANIFEST_PATH")"
  BES_VERSION="$(jq -er '.bes_firmware.version' "$MANIFEST_PATH")"
  BES_URL="$(jq -er '.bes_firmware.url' "$MANIFEST_PATH")"
  BES_SHA256="$(jq -er '.bes_firmware.sha256 | ascii_downcase' "$MANIFEST_PATH")"
  BES_SIZE="$(jq -r '.bes_firmware.size // empty' "$MANIFEST_PATH")"

  recover_orphaned_legacy_stock_files
  load_preserved_stock_update \
    || fail "Could not validate the stock ASG preserved by an interrupted firmware update"
  INITIAL_STOCK_VERSION_CODE="$(package_version_code "$STOCK_PKG")"
  if [ "$INITIAL_STOCK_VERSION_CODE" = "$BRIDGE_VERSION_CODE" ]; then
    download_verified "pinned stock ASG" "$TARGET_APK_URL" "$TARGET_APK_SHA256" "$TARGET_APK_SIZE" "$TARGET_APK_PATH"
    echo "Found an interrupted firmware update. Restoring pinned stock ASG before anything else."
    DEVICE_MUTATED=true
    BRIDGE_ACTIVE=true
    replace_bridge_with_target_stock \
      || fail "Could not recover a safe stock ASG from the interrupted firmware update"
    enable_stock_runtime \
      || fail "Recovered the stock ASG package, but could not activate its launcher"
  elif [ -n "$PRESERVED_STOCK_APK_PATH" ]; then
    # A previous run uninstalled the bridge and fell back to the built-in stock
    # but died before restoring the newer stock it had set aside. The bridge is
    # gone, so the block above is skipped; restore the preserved copy here.
    if [[ "$INITIAL_STOCK_VERSION_CODE" =~ ^[0-9]+$ ]] \
      && [ "$INITIAL_STOCK_VERSION_CODE" -ge "$PRESERVED_STOCK_VERSION_CODE" ]; then
      echo "Installed stock ASG $INITIAL_STOCK_VERSION_CODE is at least as new as preserved update $PRESERVED_STOCK_VERSION_CODE; discarding the recovery copy."
      clear_preserved_stock_update
    else
      echo "A previous firmware run left stock ASG ${INITIAL_STOCK_VERSION_CODE:-unknown} behind. Restoring preserved stock ASG $PRESERVED_STOCK_VERSION_CODE before anything else."
      DEVICE_MUTATED=true
      "${ADB[@]}" install -r "$PRESERVED_STOCK_APK_PATH" >/dev/null \
        || fail "Could not restore the stock ASG preserved by an interrupted firmware update"
      INITIAL_STOCK_VERSION_CODE="$(package_version_code "$STOCK_PKG")"
      [ "$INITIAL_STOCK_VERSION_CODE" = "$PRESERVED_STOCK_VERSION_CODE" ] \
        || fail "Restored stock ASG is ${INITIAL_STOCK_VERSION_CODE:-unknown}, not preserved $PRESERVED_STOCK_VERSION_CODE"
      clear_preserved_stock_update
      enable_stock_runtime \
        || fail "Restored the preserved stock ASG, but could not activate its launcher"
    fi
  fi

  INITIAL_MTK="$("${ADB[@]}" shell getprop ro.custom.ota.version 2>/dev/null | tr -d '\r\n')"
  [ -n "$INITIAL_MTK" ] || fail "Could not read ro.custom.ota.version from Mentra Live"
  [[ "$INITIAL_MTK" =~ ^MentraLive_[0-9]{8}(\.[0-9]+)?$ ]] \
    || fail "Unsupported MTK firmware version reported by device: $INITIAL_MTK"
  MTK_TARGET="$INITIAL_MTK"
  BES_BEFORE="$(read_bes_version || true)"
  decide_asg_action

  echo "Before versions:"
  echo "  ASG: ${ASG_BEFORE_NAME:-unknown} (${ASG_BEFORE_CODE:-unknown})"
  echo "  MTK: $INITIAL_MTK"
  echo "  BES: ${BES_BEFORE:-unreadable}"
  echo "Target versions:"
  echo "  ASG: $TARGET_VERSION_NAME ($TARGET_VERSION_CODE)"
  echo "  MTK: from the pinned manifest, starting at $INITIAL_MTK"
  echo "  BES: $BES_VERSION"

  MTK_PLAN_RESULT=""
  build_mtk_plan "$MANIFEST_PATH" "$INITIAL_MTK" "$MTK_PLAN_PATH"
  if [ "$MTK_PLAN_RESULT" = "newer" ]; then
    if [ "$STOCK_UPDATE_MODE" = "refurb" ]; then
      stock_fail 14 "MTK $INITIAL_MTK is newer than the pinned manifest; refusing to downgrade it"
    fi
    echo "MTK is newer than the pin. Skipping the MTK update."
  elif [ -n "$BES_BEFORE" ] && valid_bes_version "$BES_BEFORE" && version_at_least "$BES_BEFORE" "$BES_VERSION" \
    && [ "$BES_BEFORE" != "$BES_VERSION" ]; then
    if [ "$STOCK_UPDATE_MODE" = "refurb" ]; then
      stock_fail 14 "BES $BES_BEFORE is newer than pinned $BES_VERSION; refusing to downgrade it"
    fi
    echo "BES is newer than the pin. It will not be downgraded."
  fi

  announce_asg_action
  if [ ! -s "$TARGET_APK_PATH" ]; then
    download_verified "pinned stock ASG" "$TARGET_APK_URL" "$TARGET_APK_SHA256" "$TARGET_APK_SIZE" "$TARGET_APK_PATH"
  fi
  download_verified "BES firmware $BES_VERSION" "$BES_URL" "$BES_SHA256" "$BES_SIZE" "$BES_PATH"
  if [ "$MTK_PLAN_RESULT" != "current" ] && [ "$MTK_PLAN_RESULT" != "newer" ]; then
    echo "MTK plan is ready ($MTK_PLAN_RESULT)."
  fi
  echo "All OTA artifacts are downloaded and verified."

  disable_competing_launchers

  if [ "$ASG_ACTION" = "install" ] || [ "$ASG_ACTION" = "replace" ]; then
    DEVICE_MUTATED=true
    install_pinned_asg
  else
    enable_stock_runtime || fail "Could not activate the stock launcher before MTK"
  fi

  if [ "$MTK_PLAN_RESULT" != "newer" ] && [ "$MTK_PLAN_RESULT" != "current" ]; then
    DEVICE_MUTATED=true
    apply_mtk_plan
  else
    echo "MTK update skipped ($MTK_PLAN_RESULT)."
  fi

  local bes_now bridge_used=false
  bes_now="$(read_bes_version || true)"
  if [ -z "$bes_now" ] || ! valid_bes_version "$bes_now"; then
    phase "Pinned stock ASG cannot read BES; using the compatibility bridge"
    DEVICE_MUTATED=true
    bridge_used=true
    download_verified "firmware compatibility client" "$BRIDGE_APK_URL" \
      "${STOCK_UPDATE_BRIDGE_SHA256:-$BRIDGE_APK_SHA256}" \
      "${STOCK_UPDATE_BRIDGE_SIZE:-$BRIDGE_APK_SIZE}" "$BRIDGE_APK_PATH"
    preserve_newer_stock_update \
      || fail "Could not preserve the newer installed stock ASG before BES recovery"
    "${ADB[@]}" install -r "$BRIDGE_APK_PATH"
    [ "$(package_version_code "$STOCK_PKG")" = "$BRIDGE_VERSION_CODE" ] \
      || fail "Firmware compatibility client did not produce versionCode $BRIDGE_VERSION_CODE"
    BRIDGE_ACTIVE=true
    "${ADB[@]}" shell am start -n "$STOCK_COMPONENT" >/dev/null
    sleep 20
    bes_now="$(read_bes_version || true)"
    [ -n "$bes_now" ] && valid_bes_version "$bes_now" \
      || stock_fail 13 "BES still cannot be read after the compatibility bridge; rerun when the glasses reconnect"
    echo "Compatibility bridge read BES $bes_now."
  else
    echo "Pinned stock ASG read BES $bes_now. The compatibility bridge is not needed."
  fi
  flash_bes_if_needed "$bes_now"
  if [ "$bridge_used" = true ]; then
    phase "Restoring pinned stock ASG after BES recovery"
    replace_bridge_with_target_stock \
      || fail "Could not restore pinned stock ASG after BES recovery"
    enable_stock_runtime || fail "Restored stock ASG, but its launcher did not become HOME"
  fi

  FINAL_MTK="$("${ADB[@]}" shell getprop ro.custom.ota.version 2>/dev/null | tr -d '\r\n')"
  FINAL_ASG_CODE="$(package_version_code "$STOCK_PKG")"
  FINAL_ASG_NAME="$(package_version_name "$STOCK_PKG")"
  FINAL_BES="$(read_bes_version || true)"
  phase "Final versions read from the glasses"
  echo "  ASG: ${FINAL_ASG_NAME:-unknown} (${FINAL_ASG_CODE:-unknown})"
  echo "  MTK: ${FINAL_MTK:-unknown}"
  echo "  BES: ${FINAL_BES:-unreadable}"

  if [ "$STOCK_UPDATE_MODE" = "refurb" ]; then
    [ -n "$FINAL_BES" ] && [ "$FINAL_BES" = "$BES_VERSION" ] \
      || stock_fail 13 "Final BES read is ${FINAL_BES:-unreadable}, not pinned $BES_VERSION"
    if [ "$MTK_PLAN_RESULT" = "current" ]; then
      [ "$FINAL_MTK" = "$INITIAL_MTK" ] \
        || stock_fail 13 "Final MTK read is ${FINAL_MTK:-unknown}, not already-current $INITIAL_MTK"
    else
      [ "$FINAL_MTK" = "$MTK_TARGET" ] \
        || stock_fail 13 "Final MTK read is ${FINAL_MTK:-unknown}, not pinned $MTK_TARGET"
    fi
    if [ "$ASG_ACTION" = "retain" ]; then
      asg_prerelease_name "$FINAL_ASG_NAME" && stock_fail 13 "Retained ASG still has a prerelease version name"
      [ "$FINAL_ASG_CODE" -gt "$TARGET_VERSION_CODE" ] || stock_fail 13 "Retained ASG is not newer than the pin"
    else
      [ "$FINAL_ASG_CODE" = "$TARGET_VERSION_CODE" ] && [ "$FINAL_ASG_NAME" = "$TARGET_VERSION_NAME" ] \
        || stock_fail 13 "Final ASG read is ${FINAL_ASG_NAME:-unknown} (${FINAL_ASG_CODE:-unknown}), not $TARGET_VERSION_NAME ($TARGET_VERSION_CODE)"
    fi
  else
    [[ "$FINAL_ASG_CODE" =~ ^[0-9]+$ ]] && [ "$FINAL_ASG_CODE" -ge "$TARGET_VERSION_CODE" ] \
      || fail "Stock ASG versionCode ${FINAL_ASG_CODE:-unknown} is below manifest target $TARGET_VERSION_CODE"
  fi

  if [ "$RESUME_THIRDPARTY" = true ]; then
    phase "Returning to the installed third-party ASG Client"
    enable_thirdparty_runtime
    echo "$DEV_PKG is active again; its APK and app data were preserved."
  fi
  SUCCESS=true
  phase "Update finished"
}
