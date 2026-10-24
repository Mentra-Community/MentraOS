#!/usr/bin/env bash
set -euo pipefail
mobile_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Override permits proving the checks against a pristine package in a temp directory.
webview_java="${WEBVIEW_ANDROID_SOURCE_DIR:-$mobile_dir/node_modules/react-native-webview/android/src/main/java}"
client="$webview_java/com/reactnativecommunity/webview/RNCWebViewClient.java"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
# RNCWebViewClient.MiniappOrigin uses only the JDK: compile it alone, as a top-level class.
mkdir -p "$build_dir/src"
{
  echo "package com.reactnativecommunity.webview;"
  grep -E '^import java\.' "$client"
  sed -n '/BEGIN MiniappOrigin/,/END MiniappOrigin/p' "$client" |
    sed 's/public static final class MiniappOrigin /public final class MiniappOrigin /'
} > "$build_dir/src/MiniappOrigin.java"
grep -q 'public final class MiniappOrigin ' "$build_dir/src/MiniappOrigin.java" ||
  { echo "RNCWebViewClient.MiniappOrigin not found in $client" >&2; exit 1; }
javac -d "$build_dir/classes" "$build_dir/src/MiniappOrigin.java" \
  "$mobile_dir/test/native/RNCWebViewMiniappOriginTest.java"
java -cp "$build_dir/classes" com.reactnativecommunity.webview.RNCWebViewMiniappOriginTest
