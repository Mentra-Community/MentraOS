#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: build-coordinated-asg.sh <version-code> <version-name>" >&2
  exit 2
fi

version_code="$1"
version_name="$2"

cp asg_client/.env.example asg_client/.env
git submodule update --init asg_client/StreamPackLite
chmod +x asg_client/recovery_worker/build_and_deploy.sh
(
  cd asg_client/recovery_worker
  ./build_and_deploy.sh
)
test -f asg_client/app/src/main/assets/recovery_worker.apk

(
  cd asg_client
  ./gradlew \
    -PASG_VERSION_CODE="$version_code" \
    -PASG_VERSION_NAME="$version_name" \
    assembleRelease --build-cache --parallel
)
