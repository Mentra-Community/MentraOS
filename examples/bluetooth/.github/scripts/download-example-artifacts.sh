#!/usr/bin/env bash
set -euo pipefail

run_id="${1:?Expected a workflow run ID}"
for attempt in 1 2 3; do
  # A failed archive extraction may leave partial files behind.
  rm -rf validated-artifacts
  if gh run download "$run_id" --repo "$STARTER_KIT_REPOSITORY" --dir validated-artifacts; then
    exit 0
  fi
  echo "Could not download example artifacts from run $run_id ($attempt/3 attempts)." >&2
  if (( attempt < 3 )); then
    sleep 10
  fi
done
exit 1
