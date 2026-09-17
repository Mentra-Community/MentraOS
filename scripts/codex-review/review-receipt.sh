#!/usr/bin/env bash
# Count reviews on a PR that prove a local Codex run posted its verdict:
# on the given head commit, carrying the standard body marker, submitted at or
# after the given UTC timestamp.
#
# usage: review-receipt.sh <owner/repo> <pr-number> <head-sha> <since-iso8601>
#
# Prints the count and exits 0 when GitHub answered. Exits 2 and prints nothing
# when the answer is unknown (API failure, partial pagination, unparseable
# output): callers must treat "unknown" differently from "zero".
set -uo pipefail
slug="$1"; pr="$2"; head_sha="$3"; since="$4"
pages=$(gh api "repos/${slug}/pulls/${pr}/reviews" --paginate \
  --jq "[.[] | select(.commit_id == \"${head_sha}\" and (.body | contains(\"Reviewed by local Codex\")) and .submitted_at >= \"${since}\")] | length") \
  || exit 2
count=$(printf '%s\n' "$pages" | awk 'NF { if ($1 !~ /^[0-9]+$/) { bad = 1 } else { n += $1 } } END { if (bad) exit 2; print n + 0 }') || exit 2
[[ "$count" =~ ^[0-9]+$ ]] || exit 2
echo "$count"
