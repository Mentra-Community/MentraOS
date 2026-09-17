#!/usr/bin/env bash
# Count reviews on a PR that prove a local Codex run posted its verdict:
# on the given head commit, carrying the standard body marker, submitted at or
# after the given UTC timestamp. Prints the count; exits 0 unless gh fails.
#
# usage: review-receipt.sh <owner/repo> <pr-number> <head-sha> <since-iso8601>
set -euo pipefail
slug="$1"; pr="$2"; head_sha="$3"; since="$4"
gh api "repos/${slug}/pulls/${pr}/reviews" --paginate \
  --jq "[.[] | select(.commit_id == \"${head_sha}\" and (.body | contains(\"Reviewed by local Codex\")) and .submitted_at >= \"${since}\")] | length" \
  | awk '{ n += $1 } END { print n + 0 }'
