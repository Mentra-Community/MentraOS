#!/usr/bin/env bash
set -euo pipefail

run_id="${1:?Expected a workflow run ID}"
# The caller retains its existing 120-minute job limit for healthy builds.
while true; do
  state=$(gh run view "$run_id" --repo "$STARTER_KIT_REPOSITORY" --json status,conclusion,jobs)
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
