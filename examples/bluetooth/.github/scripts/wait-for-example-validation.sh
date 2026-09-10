#!/usr/bin/env bash
set -euo pipefail

run_id="${1:?Expected a workflow run ID}"
read_failures=0
# The caller retains its existing 120-minute job limit for healthy builds.
while true; do
  if ! state=$(gh run view "$run_id" --repo "$STARTER_KIT_REPOSITORY" --json status,conclusion,jobs); then
    read_failures=$((read_failures + 1))
    echo "Could not read example validation run $run_id ($read_failures/3 consecutive attempts)." >&2
    if (( read_failures >= 3 )); then
      exit 1
    fi
    sleep 10
    continue
  fi
  read_failures=0
  failures=$(jq -r '.jobs[] | select(.conclusion != null and .conclusion != "" and .conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral") | "\(.name): \(.conclusion)"' <<< "$state")
  if [[ -n "$failures" ]]; then
    echo "Example validation failed in run $run_id:" >&2
    echo "$failures" >&2
    exit 1
  fi
  if [[ "$(jq -r .status <<< "$state")" == "completed" ]]; then
    if [[ "$(jq -r .conclusion <<< "$state")" != "success" ]]; then
      echo "Example validation run $run_id concluded $(jq -r .conclusion <<< "$state")." >&2
      exit 1
    fi
    exit 0
  fi
  sleep 10
done
