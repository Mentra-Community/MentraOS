#!/usr/bin/env bash
# Write compiler wrappers that invoke ccache with the cache env baked in.
#
# React Native 0.83's ccache-clang.sh does `exec $CCACHE_BINARY clang "$@"`.
# Xcode 16 CompileC does not export user-defined build settings, so
# CCACHE_BINARY is empty inside that wrapper and it falls through to plain
# clang (facebook/react-native#55381). These wrappers do not read
# CCACHE_BINARY from the environment.
#
# Usage: ios-ccache-wrappers.sh [ccache-binary] [output-dir]
#   Defaults: $(command -v ccache), $MENTRA_IOS_CCACHE_WRAPPER_DIR or $RUNNER_TEMP.
# Writes mentra-ccache-clang.sh and mentra-ccache-clang++.sh, prints both
# paths on stdout (one per line). Requires CCACHE_DIR, CCACHE_CONFIGPATH,
# CCACHE_BASEDIR, CCACHE_STATSLOG.
set -euo pipefail

quote() {
  # Single-quote a path for a POSIX sh assignment. Paths are rejected first
  # (command substitution cannot abort the parent via `exit`).
  printf "'%s'" "$1"
}

reject_unsafe() {
  case "$1" in
    *"'"*|*$'\n'*)
      echo "ios-ccache-wrappers.sh: unsafe path: $1" >&2
      exit 1
      ;;
  esac
}

ccache_bin="${1:-${CCACHE_BINARY:-$(command -v ccache || true)}}"
out_dir="${2:-${MENTRA_IOS_CCACHE_WRAPPER_DIR:-${RUNNER_TEMP:-}}}"

if [ -z "$ccache_bin" ] || [ ! -x "$ccache_bin" ]; then
  echo "ios-ccache-wrappers.sh: ccache binary not found" >&2
  exit 1
fi
if [ -z "$out_dir" ]; then
  echo "ios-ccache-wrappers.sh: output dir required (MENTRA_IOS_CCACHE_WRAPPER_DIR or RUNNER_TEMP)" >&2
  exit 1
fi
: "${CCACHE_DIR:?ios-ccache-wrappers.sh: CCACHE_DIR is required}"
: "${CCACHE_CONFIGPATH:?ios-ccache-wrappers.sh: CCACHE_CONFIGPATH is required}"
: "${CCACHE_BASEDIR:?ios-ccache-wrappers.sh: CCACHE_BASEDIR is required}"
: "${CCACHE_STATSLOG:?ios-ccache-wrappers.sh: CCACHE_STATSLOG is required}"
for p in "$ccache_bin" "$out_dir" "$CCACHE_DIR" "$CCACHE_CONFIGPATH" "$CCACHE_BASEDIR" "$CCACHE_STATSLOG"; do
  reject_unsafe "$p"
done

mkdir -p "$out_dir"

write_wrapper() {
  local path="$1" compiler="$2"
  cat > "$path" <<EOF
#!/bin/sh
export CCACHE_DIR=$(quote "$CCACHE_DIR")
export CCACHE_CONFIGPATH=$(quote "$CCACHE_CONFIGPATH")
export CCACHE_BASEDIR=$(quote "$CCACHE_BASEDIR")
export CCACHE_STATSLOG=$(quote "$CCACHE_STATSLOG")
export CCACHE_NOHASHDIR=1
exec $(quote "$ccache_bin") $compiler "\$@"
EOF
  chmod +x "$path"
}

clang_sh="$out_dir/mentra-ccache-clang.sh"
clangpp_sh="$out_dir/mentra-ccache-clang++.sh"
write_wrapper "$clang_sh" clang
write_wrapper "$clangpp_sh" clang++
printf '%s\n' "$clang_sh" "$clangpp_sh"
