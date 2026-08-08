#!/usr/bin/env bash

set -euo pipefail

manifest_path="${1:?Usage: validate-asg-ota-manifest.sh <manifest-path> [--check-apk]}"
check_apk="${2:-}"

if [[ "$check_apk" != "" && "$check_apk" != "--check-apk" ]]; then
  echo "Unknown option: $check_apk" >&2
  exit 2
fi

jq -e '
  def valid_bes_version:
    if type != "string" then false
    else split(".") as $parts
      | ($parts | length == 4)
        and all($parts[];
          test("^[0-9]{1,3}$")
          and (tonumber <= 255))
    end;

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
    and ($bes.version | valid_bes_version)
    and ($bes.url
      | type == "string"
        and test("^https://[^/?#[:space:]]+(?:/[^/?#[:space:]]*)*/[A-Za-z0-9._-]{1,128}$"))
    and ($bes.sha256 | type == "string" and test("^[0-9a-fA-F]{64}$"))
' "$manifest_path" >/dev/null

if [[ "$check_apk" == "--check-apk" ]]; then
  apk_url=$(jq -er '.apps["com.mentra.asg_client"].apkUrl' "$manifest_path")
  curl --fail --silent --head --location "$apk_url" >/dev/null
fi
