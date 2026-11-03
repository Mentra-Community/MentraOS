#!/usr/bin/env bash
set -euo pipefail

apk=${1:?Usage: check-android-16kb.sh path/to/app.apk}
android_sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}

if [[ -z "$android_sdk" ]]; then
  echo "ANDROID_HOME or ANDROID_SDK_ROOT must point to the Android SDK." >&2
  exit 2
fi

build_tools=$(find "$android_sdk/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)
ndk_root=$(find "$android_sdk/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) host=darwin-x86_64 ;;
  Darwin-*) host=darwin-x86_64 ;;
  Linux-x86_64) host=linux-x86_64 ;;
  Linux-aarch64) host=linux-x86_64 ;;
  *) echo "Unsupported build host: $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac

zipalign="$build_tools/zipalign"
readelf="$ndk_root/toolchains/llvm/prebuilt/$host/bin/llvm-readelf"

[[ -x "$zipalign" ]] || { echo "zipalign not found under $build_tools" >&2; exit 2; }
[[ -x "$readelf" ]] || { echo "llvm-readelf not found under $ndk_root" >&2; exit 2; }
[[ -f "$apk" ]] || { echo "APK not found: $apk" >&2; exit 2; }

echo "Checking 16 KB ZIP alignment: $apk"
"$zipalign" -c -P 16 -v 4 "$apk" >/dev/null

audit_dir=$(mktemp -d "${TMPDIR:-/tmp}/android-16kb.XXXXXX")
unzip -q "$apk" 'lib/*/*.so' -d "$audit_dir"

libraries=()
while IFS= read -r library; do
  libraries+=("$library")
done < <(find "$audit_dir/lib" -type f -name '*.so' -print | sort)
if [[ ${#libraries[@]} -eq 0 ]]; then
  echo "No packaged native libraries found in $apk" >&2
  exit 1
fi

failures=0
for library in "${libraries[@]}"; do
  relative=${library#"$audit_dir/"}
  if ! program_headers=$("$readelf" -lW "$library"); then
    printf 'FAIL %s (llvm-readelf could not inspect the library)\n' "$relative" >&2
    failures=$((failures + 1))
    continue
  fi

  alignments=()
  while IFS= read -r alignment; do
    alignments+=("$alignment")
  done < <(printf '%s\n' "$program_headers" | awk '$1 == "LOAD" { print $NF }')
  if [[ ${#alignments[@]} -eq 0 ]]; then
    printf 'FAIL %s (no ELF LOAD segments found)\n' "$relative" >&2
    failures=$((failures + 1))
    continue
  fi

  bad_alignments=()
  for alignment in "${alignments[@]}"; do
    if (( alignment < 0x4000 )); then
      bad_alignments+=("$alignment")
    fi
  done

  if [[ ${#bad_alignments[@]} -gt 0 ]]; then
    printf 'FAIL %s (LOAD alignment: %s)\n' "$relative" "${bad_alignments[*]}" >&2
    failures=$((failures + 1))
  else
    printf 'PASS %s\n' "$relative"
  fi
done

if (( failures > 0 )); then
  echo "$failures native libraries are not 16 KB ELF-aligned." >&2
  exit 1
fi

echo "Verified ${#libraries[@]} packaged native libraries for 16 KB page-size support."
