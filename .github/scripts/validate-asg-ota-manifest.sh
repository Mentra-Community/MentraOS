#!/usr/bin/env bash

set -euo pipefail

manifest_path="${1:?Usage: validate-asg-ota-manifest.sh <manifest-path> [--check-apk]}"
check_apk="${2:-}"

if [[ "$check_apk" != "" && "$check_apk" != "--check-apk" ]]; then
  echo "Unknown option: $check_apk" >&2
  exit 2
fi

jq -e '
  .apps["com.mentra.asg_client"] as $app
  | .bes_firmware as $bes
  | ($app | type == "object")
    and ($app.versionCode | type == "number" and . > 0)
    and ($app.versionName | type == "string" and length > 0)
    and ($app.apkUrl | type == "string" and test("^https://[^[:space:]]+$"))
    and ($app.apkSize | type == "number" and . > 0)
    and ($app.sha256 | type == "string" and test("^[0-9a-fA-F]{64}$"))
    and (.mtk_patches | type == "array" and length > 0)
    and ($bes | type == "object")
    and ($bes.version | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$"))
    and ($bes.url | type == "string" and test("^https://[^?#[:space:]]+$"))
    and ($bes.sha256 | type == "string" and test("^[0-9a-fA-F]{64}$"))
    and ($bes.format == "bes-lzma-chunks-v1")
    and ($bes.product == "best1502x_ibrt_bpone")
    and ($bes.artifact_id | type == "string" and test("^[A-Za-z0-9._-]{1,128}$"))
    and ($bes.url | endswith("/" + $bes.artifact_id))
    and ($bes.compressed_size | type == "number" and . > 0)
    and ($bes.decompressed_size | type == "number" and . > 0 and . < 1966080)
    and ($bes.decompressed_sha256 | type == "string" and test("^[0-9a-fA-F]{64}$"))
    and ($bes.version_offset | type == "number" and . >= 0)
' "$manifest_path" >/dev/null

if [[ "$check_apk" == "--check-apk" ]]; then
  apk_url=$(jq -er '.apps["com.mentra.asg_client"].apkUrl' "$manifest_path")
  curl --fail --silent --head --location "$apk_url" >/dev/null
fi
