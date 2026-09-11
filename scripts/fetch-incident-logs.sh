#!/bin/bash
# scripts/fetch-incident-logs.sh
# Fetch a Cloud V2 bug report and its artifacts (log bundles, screenshots)
# for debugging. Reports are filed from the Mentra App and stored by the
# Cloud V2 reports service; this script reads them back through the admin
# reports API (GET /api/admin/reports/...).
#
# Usage:
#   ./scripts/fetch-incident-logs.sh <reportId> [options]   Download report + artifacts
#   ./scripts/fetch-incident-logs.sh --list [options]       List recent reports (JSON)
#
# Options:
#   -o, --out DIR    Output directory (default: ./incident-logs/<reportId>)
#   --json           Print the raw report JSON to stdout, skip artifact downloads
#   --env ENV        prod | staging | dev (default: auto-discover)
#   --kind KIND      (--list) bug | feedback | automatic
#   --status STATUS  (--list) collecting | ready | closed
#   --limit N        (--list) max reports to return (1-200, default 50)
#
# Environment variables:
#   MENTRA_ADMIN_TOKEN  (required) Bearer token for the admin API: an org API
#                       key (msk_...) whose synthetic email is allowlisted in
#                       CLOUD_CORE_ADMIN_EMAILS, or a WorkOS access token of
#                       an admin user.
#   MENTRA_CORE_URL     (optional) Core API base URL; disables auto-discovery
#                       and overrides --env.

set -euo pipefail

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

err() { echo "Error: $*" >&2; }
note() { echo "$*" >&2; }

command -v curl >/dev/null || { err "curl is required"; exit 1; }
command -v jq >/dev/null || { err "jq is required (brew install jq)"; exit 1; }

REPORT_ID=""
OUT_DIR=""
MODE="fetch"
ENV_NAME=""
ENV_EXPLICIT=0
LIST_KIND=""
LIST_STATUS=""
LIST_LIMIT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE="list" ;;
    --json) MODE="json" ;;
    -o|--out) OUT_DIR="${2:?--out requires a directory}"; shift ;;
    --env) ENV_NAME="${2:?--env requires prod|staging|dev}"; ENV_EXPLICIT=1; shift ;;
    --kind) LIST_KIND="${2:?--kind requires a value}"; shift ;;
    --status) LIST_STATUS="${2:?--status requires a value}"; shift ;;
    --limit) LIST_LIMIT="${2:?--limit requires a number}"; shift ;;
    -h|--help) usage ;;
    -*) err "unknown option: $1"; usage ;;
    *)
      if [ -n "$REPORT_ID" ]; then err "unexpected argument: $1"; usage; fi
      REPORT_ID="$1"
      ;;
  esac
  shift
done

if [ "$ENV_EXPLICIT" -eq 1 ]; then
  case "$ENV_NAME" in
    prod|staging|dev) ;;
    *) err "--env must be prod, staging, or dev (got: $ENV_NAME)"; exit 1 ;;
  esac
fi

core_url_for_env() {
  case "$1" in
    prod) echo "https://core.mentraglass.com" ;;
    staging) echo "https://core.staging.us-west-2.mentraglass.com" ;;
    dev) echo "https://core.dev.us-west-2.mentraglass.com" ;;
    *) return 1 ;;
  esac
}

CANDIDATE_NAMES=()
CANDIDATE_URLS=()
if [ -n "${MENTRA_CORE_URL:-}" ]; then
  CANDIDATE_NAMES+=("custom")
  CANDIDATE_URLS+=("${MENTRA_CORE_URL%/}")
elif [ "$ENV_EXPLICIT" -eq 1 ]; then
  CANDIDATE_NAMES+=("$ENV_NAME")
  CANDIDATE_URLS+=("$(core_url_for_env "$ENV_NAME")")
else
  for candidate_env in prod dev staging; do
    CANDIDATE_NAMES+=("$candidate_env")
    CANDIDATE_URLS+=("$(core_url_for_env "$candidate_env")")
  done
fi

CORE_URL=""
SELECTED_ENV=""

if [ "$MODE" != "list" ] && [ -z "$REPORT_ID" ]; then
  usage
fi
if [ -n "$REPORT_ID" ] && ! printf '%s' "$REPORT_ID" | grep -Eq '^[A-Za-z0-9_-]+$'; then
  err "report id contains unexpected characters: $REPORT_ID"
  exit 1
fi

if [ -z "${MENTRA_ADMIN_TOKEN:-}" ]; then
  err "MENTRA_ADMIN_TOKEN environment variable not set"
  note ""
  note "The admin reports API needs a bearer token with admin access:"
  note "  - an org API key (msk_...) allowlisted via CLOUD_CORE_ADMIN_EMAILS, or"
  note "  - a WorkOS access token of an admin user"
  note ""
  note "  export MENTRA_ADMIN_TOKEN=msk_..."
  exit 1
fi

# api_get PATH OUTFILE -> echoes HTTP status; body lands in OUTFILE.
api_get() {
  curl -sS -m 60 \
    -H "Authorization: Bearer $MENTRA_ADMIN_TOKEN" \
    -H "Accept: application/json" \
    -o "$2" -w '%{http_code}' \
    "$CORE_URL$1"
}

fail_for_status() {
  local status="$1" body="$2" what="$3"
  case "$status" in
    2??) return 0 ;;
    401) err "unauthorized (401) fetching $what — MENTRA_ADMIN_TOKEN was rejected" ;;
    403) err "forbidden (403) fetching $what — token is valid but not admin-allowlisted (CLOUD_CORE_ADMIN_EMAILS)" ;;
    404) err "not found (404) fetching $what — wrong report id, or this environment does not serve the admin reports API yet" ;;
    *) err "HTTP $status fetching $what" ;;
  esac
  if [ -s "$body" ]; then jq . "$body" >&2 2>/dev/null || cat "$body" >&2; fi
  exit 1
}

# discover_get PATH OUTFILE WHAT
#
# Uses a single backend when --env or MENTRA_CORE_URL is explicit. Otherwise,
# tries each Cloud V2 environment until the request succeeds. This matters for
# environment-pinned msk_<env>_* API keys and report ids whose origin is not
# known when copied from a notification.
discover_get() {
  local path="$1" body="$2" what="$3"
  local i status attempts=""

  for ((i = 0; i < ${#CANDIDATE_URLS[@]}; i++)); do
    CORE_URL="${CANDIDATE_URLS[$i]}"
    SELECTED_ENV="${CANDIDATE_NAMES[$i]}"
    note "Trying $SELECTED_ENV reports backend: $CORE_URL"
    STATUS=$(api_get "$path" "$body") || STATUS="000"
    status="$STATUS"
    if printf '%s' "$status" | grep -q '^2'; then
      note "Using reports backend: $SELECTED_ENV ($CORE_URL)"
      return 0
    fi

    attempts="${attempts}${attempts:+, }$SELECTED_ENV=HTTP $status"
    if [ "${#CANDIDATE_URLS[@]}" -eq 1 ]; then
      fail_for_status "$status" "$body" "$what"
    fi
  done

  err "could not fetch $what from any reports backend ($attempts)"
  if [ -s "$body" ]; then jq . "$body" >&2 2>/dev/null || cat "$body" >&2; fi
  exit 1
}

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if [ "$MODE" = "list" ]; then
  QUERY=""
  [ -n "$LIST_KIND" ] && QUERY="$QUERY&kind=$LIST_KIND"
  [ -n "$LIST_STATUS" ] && QUERY="$QUERY&status=$LIST_STATUS"
  [ -n "$LIST_LIMIT" ] && QUERY="$QUERY&limit=$LIST_LIMIT"
  QUERY="${QUERY#&}"
  note "Listing reports${QUERY:+ ($QUERY)}"
  BODY="$TMP_DIR/list.json"
  discover_get "/api/admin/reports${QUERY:+?$QUERY}" "$BODY" "report list"
  jq . "$BODY"
  exit 0
fi

note "Fetching report $REPORT_ID"
DETAIL="$TMP_DIR/detail.json"
discover_get "/api/admin/reports/$REPORT_ID" "$DETAIL" "report $REPORT_ID"

if [ "$MODE" = "json" ]; then
  jq . "$DETAIL"
  exit 0
fi

OUT_DIR="${OUT_DIR:-./incident-logs/$REPORT_ID}"
mkdir -p "$OUT_DIR"
jq . "$DETAIL" > "$OUT_DIR/report.json"

KIND=$(jq -r '.report.kind' "$DETAIL")
REPORT_STATUS=$(jq -r '.report.status' "$DETAIL")
ARTIFACT_COUNT=$(jq '.report.artifacts | length' "$DETAIL")
note "Report kind: $KIND, status: $REPORT_STATUS, artifacts: $ARTIFACT_COUNT"
if [ "$REPORT_STATUS" = "collecting" ]; then
  note "Note: status is 'collecting' — the device may still be uploading artifacts"
fi

ext_for_content_type() {
  case "${1%%;*}" in
    application/json) echo "json" ;;
    image/png) echo "png" ;;
    image/jpeg) echo "jpg" ;;
    image/webp) echo "webp" ;;
    image/gif) echo "gif" ;;
    text/*) echo "txt" ;;
    *) echo "bin" ;;
  esac
}

# Artifact type/source/filename are report metadata (source and filename are
# client-supplied free text), so strip anything path-like before they can
# shape a local filename.
sanitize_component() {
  printf '%s' "$1" | tr -cd 'A-Za-z0-9._-' | cut -c1-40
}

FAILED=0
INDEX=0
while IFS=$'\t' read -r ARTIFACT_ID TYPE SOURCE CONTENT_TYPE FILENAME; do
  [ -n "$ARTIFACT_ID" ] || continue
  INDEX=$((INDEX + 1))
  EXT=$(ext_for_content_type "$CONTENT_TYPE")
  SAFE_TYPE=$(sanitize_component "$TYPE")
  SAFE_SOURCE=$(sanitize_component "$SOURCE")
  SAFE_NAME=$(sanitize_component "$FILENAME")
  SAFE_NAME="${SAFE_NAME%.*}"
  FILE=$(printf '%02d-%s-%s%s.%s' "$INDEX" "${SAFE_TYPE:-artifact}" "${SAFE_SOURCE:-unknown}" "${SAFE_NAME:+-$SAFE_NAME}" "$EXT")
  BODY="$TMP_DIR/artifact"
  STATUS=$(api_get "/api/admin/reports/$REPORT_ID/artifacts/$ARTIFACT_ID" "$BODY") || STATUS="000"
  if ! printf '%s' "$STATUS" | grep -q '^2'; then
    err "artifact $ARTIFACT_ID ($TYPE/$SOURCE) failed with HTTP $STATUS — skipping"
    FAILED=$((FAILED + 1))
    continue
  fi
  if [ "$EXT" = "json" ] && jq . "$BODY" > "$TMP_DIR/pretty" 2>/dev/null; then
    mv "$TMP_DIR/pretty" "$OUT_DIR/$FILE"
  else
    mv "$BODY" "$OUT_DIR/$FILE"
  fi
  note "  saved $FILE"
done < <(jq -r '.report.artifacts[] | [.artifactId, .type, .source, (.contentType // ""), (.filename // "")] | @tsv' "$DETAIL")

echo "$OUT_DIR"
ls -lh "$OUT_DIR" >&2

if [ "$FAILED" -gt 0 ]; then
  err "$FAILED artifact(s) failed to download"
  exit 1
fi
