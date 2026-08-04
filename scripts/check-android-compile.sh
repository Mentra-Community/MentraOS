#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: scripts/check-android-compile.sh [all|asg|bluetooth-sdk] [gradle args...]

Runs focused local Android compile checks using repo-owned Gradle wrappers.

Targets:
  asg             Run asg_client :app Java debug compile.
  bluetooth-sdk   Prepare mobile/android and run the public-mode Bluetooth SDK Android AAR compile.
  all             Run both targets. This is the default.

Set MENTRA_ANDROID_CHECK_SKIP_PREBUILD=1 to reuse an existing mobile/android
project instead of running Expo prebuild for the bluetooth-sdk target.
USAGE
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "error: '$name' is required for this check." >&2
    return 1
  fi
}

run_asg() {
  if [[ ! -f "$repo_root/asg_client/StreamPackLite/core/build.gradle" ]]; then
    cat >&2 <<'MSG'
error: asg_client/StreamPackLite is missing.

StreamPackLite is a git submodule. Initialize it first (from the repository root):
  git submodule update --init asg_client/StreamPackLite
MSG
    return 1
  fi

  (
    cd "$repo_root/asg_client"
    ./gradlew :app:compileDebugJavaWithJavac --no-daemon "$@"
  )
}

ensure_mobile_android_project() {
  local mobile_dir="$repo_root/mobile"

  if [[ "${MENTRA_ANDROID_CHECK_SKIP_PREBUILD:-}" == "1" ]]; then
    if [[ ! -x "$mobile_dir/android/gradlew" ]]; then
      echo "error: mobile/android/gradlew is missing. Unset MENTRA_ANDROID_CHECK_SKIP_PREBUILD or run 'cd mobile && bun expo prebuild --platform android'." >&2
      return 1
    fi
    return 0
  fi

  require_command bun

  if [[ ! -d "$mobile_dir/node_modules" ]]; then
    (
      cd "$mobile_dir"
      bun install --frozen-lockfile
    )
  fi

  if [[ ! -f "$mobile_dir/.env" ]]; then
    cp "$mobile_dir/.env.example" "$mobile_dir/.env"
  fi

  (
    cd "$mobile_dir"
    bun expo prebuild --platform android
  )

  if [[ ! -x "$mobile_dir/android/gradlew" ]]; then
    echo "error: Expo prebuild did not create mobile/android/gradlew." >&2
    return 1
  fi
}

run_bluetooth_sdk() {
  ensure_mobile_android_project
  (
    cd "$repo_root/mobile/android"
    MENTRA_BLUETOOTH_SDK_PACKAGE_PATH="$repo_root/mobile/modules/bluetooth-sdk" \
      ./gradlew :mentra-bluetooth-sdk:assembleDebug --no-daemon "$@" -PmentraPublicSdk=true
  )
}

target="${1:-all}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$target" in
  -h|--help)
    usage
    ;;
  all)
    run_asg "$@"
    run_bluetooth_sdk "$@"
    ;;
  asg|asg-client)
    run_asg "$@"
    ;;
  bluetooth-sdk|sdk)
    run_bluetooth_sdk "$@"
    ;;
  *)
    echo "error: unknown target '$target'" >&2
    usage >&2
    exit 2
    ;;
esac
