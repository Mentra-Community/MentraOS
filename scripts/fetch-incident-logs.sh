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
#   --category CAT   (--list) bug | feedback | internal | testing | automatic
#   --status STATUS  (--list) collecting | ready | closed
#   --limit N        (--list) max reports to return (1-200, default 50)
#
# Keys: each environment has its own admin dashboard and its own operator key,
# with the incident read scope (organization.incidents.read):
#   MENTRA_PROD_ADMIN_TOKEN     prod     https://admin.mentraglass.com
#   MENTRA_STAGING_ADMIN_TOKEN  staging  https://admin.staging.mentraglass.com
#   MENTRA_DEV_ADMIN_TOKEN      dev      https://admin.dev.mentraglass.com
#   MENTRA_ADMIN_TOKEN          fallback for any environment, and the only key
#                               used with MENTRA_CORE_URL. An older admin key
#                               (msk_...) on CLOUD_CORE_ADMIN_EMAILS works too.
# A key made in one environment (mak_<env>_...) works only there; the script
# never sends it to another one.
#
#   MENTRA_CORE_URL     (optional) Core API base URL; disables auto-discovery
#                       and overrides --env.

set -euo pipefail

usage() {
  sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

err() { echo "Error: $*" >&2; }
note() { echo "$*" >&2; }

command -v curl >/dev/null || { err "curl is required"; exit 1; }
command -v jq >/dev/null || { err "jq is required (brew install jq)"; exit 1; }
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

REPORT_ID=""
OUT_DIR=""
MODE="fetch"
ENV_NAME=""
ENV_EXPLICIT=0
LIST_KIND=""
LIST_CATEGORY=""
LIST_STATUS=""
LIST_LIMIT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE="list" ;;
    --json) MODE="json" ;;
    -o|--out) OUT_DIR="${2:?--out requires a directory}"; shift ;;
    --env) ENV_NAME="${2:?--env requires prod|staging|dev}"; ENV_EXPLICIT=1; shift ;;
    --kind) LIST_KIND="${2:?--kind requires a value}"; shift ;;
    --category) LIST_CATEGORY="${2:?--category requires a value}"; shift ;;
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

dashboard_for_env() {
  case "$1" in
    prod) echo "https://admin.mentraglass.com" ;;
    staging) echo "https://admin.staging.mentraglass.com" ;;
    dev) echo "https://admin.dev.mentraglass.com" ;;
    *) echo "your Core's admin dashboard" ;;
  esac
}

# key_var_for_env ENV -> name of the variable holding that environment's key,
# or nothing. The environment-specific key wins over MENTRA_ADMIN_TOKEN, and a
# key whose prefix names another environment is never used.
key_var_for_env() {
  local env="$1" upper var value key_env
  upper=$(printf '%s' "$env" | tr '[:lower:]' '[:upper:]')
  for var in "MENTRA_${upper}_ADMIN_TOKEN" MENTRA_ADMIN_TOKEN; do
    [ "$env" = custom ] && [ "$var" != MENTRA_ADMIN_TOKEN ] && continue
    value="${!var:-}"
    [ -n "$value" ] || continue
    key_env=$(key_env_of "$value")
    if [ -n "$key_env" ] && [ "$env" != custom ] && [ "$key_env" != "$env" ]; then
      note "  $var is a $key_env key, not a $env one: not using it for $env"
      continue
    fi
    echo "$var"
    return 0
  done
}

# mak_<env>_... and msk_<env>_... keys name their environment.
key_env_of() {
  case "$1" in
    mak_prod_*|msk_prod_*) echo prod ;;
    mak_staging_*|msk_staging_*) echo staging ;;
    mak_dev_*|msk_dev_*) echo dev ;;
  esac
}

# key_fix ENV WHY: one line naming the exact fix for a missing or rejected key.
key_fix() {
  local env="$1" why="$2" upper
  upper=$(printf '%s' "$env" | tr '[:lower:]' '[:upper:]')
  if [ "$env" = custom ]; then
    err "$why. Fix: export MENTRA_ADMIN_TOKEN with an operator key (incident read) from your Core's admin dashboard."
    return
  fi
  err "$why. Fix: sign in at $(dashboard_for_env "$env"), create an operator key with incident read (organization.incidents.read), then add 'export MENTRA_${upper}_ADMIN_TOKEN=<key>' to ~/.zshrc and open a new shell."
}

# api_get PATH OUTFILE -> echoes HTTP status; body lands in OUTFILE.
api_get() {
  curl -sS -m 60 \
    -H "Authorization: Bearer ${!KEY_VAR}" \
    -H "Accept: application/json" \
    -o "$2" -w '%{http_code}' \
    "$CORE_URL$1"
}

fail_for_status() {
  local status="$1" body="$2" what="$3"
  case "$status" in
    2??) return 0 ;;
    401) key_fix "$SELECTED_ENV" "$SELECTED_ENV rejected the key in $KEY_VAR (401) fetching $what: it is revoked, mistyped or from another environment" ;;
    403) key_fix "$SELECTED_ENV" "$SELECTED_ENV accepted the key in $KEY_VAR but refused it (403) fetching $what: it lacks incident read, or its creator is no longer an Organization Admin" ;;
    404) err "$what is not on $SELECTED_ENV (404). It is most likely on another environment (its notification names it): run again with --env prod|staging|dev, or without --env to try every environment you have a key for." ;;
    000) err "could not reach $CORE_URL fetching $what. Fix: check your network or VPN, then run again." ;;
    *) err "HTTP $status from $SELECTED_ENV fetching $what" ;;
  esac
  [ "$status" != 404 ] && [ -s "$body" ] && { jq -c . "$body" >&2 2>/dev/null || head -c 500 "$body" >&2; }
  exit 1
}

# discover_get PATH OUTFILE WHAT
#
# Uses a single backend when --env or MENTRA_CORE_URL is explicit. Otherwise,
# tries each Cloud V2 environment until the request succeeds. This matters for
# environment-pinned mak_<env>_* and msk_<env>_* keys and report ids whose origin is not
# known when copied from a notification.
discover_get() {
  local path="$1" body="$2" what="$3"
  local i status attempts="" missing="" tried=0

  for ((i = 0; i < ${#CANDIDATE_URLS[@]}; i++)); do
    CORE_URL="${CANDIDATE_URLS[$i]}"
    SELECTED_ENV="${CANDIDATE_NAMES[$i]}"
    KEY_VAR=$(key_var_for_env "$SELECTED_ENV")
    if [ -z "$KEY_VAR" ]; then
      missing="${missing}${missing:+ }$SELECTED_ENV"
      continue
    fi
    tried=$((tried + 1))
    note "Trying $SELECTED_ENV ($CORE_URL) with $KEY_VAR"
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

  if [ "$tried" -eq 0 ]; then
    for env in $missing; do key_fix "$env" "no key for $env"; done
    exit 1
  fi
  err "could not fetch $what (${attempts})."
  for env in $missing; do key_fix "$env" "it may be on $env, which has no key"; done
  if [ -z "$missing" ]; then
    err "A 404 everywhere means a wrong report id; a 401/403 means that environment's key needs replacing (run with --env <env> for its fix)."
  fi
  exit 1
}

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if [ "$MODE" = "list" ]; then
  QUERY=""
  [ -n "$LIST_KIND" ] && QUERY="$QUERY&kind=$LIST_KIND"
  [ -n "$LIST_CATEGORY" ] && QUERY="$QUERY&category=$LIST_CATEGORY"
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
    video/mp4) echo "mp4" ;;
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
  mv "$BODY" "$OUT_DIR/$FILE"
  if [ "$TYPE" = "state_snapshot" ] && [ "$SOURCE" = "framework-diagnostic" ]; then
    SIZE=$(jq -r --arg id "$ARTIFACT_ID" '.assets[] | select(.artifactId == $id) | .sizeBytes' "$DETAIL")
    SHA=$(jq -r --arg id "$ARTIFACT_ID" '.assets[] | select(.artifactId == $id) | .sha256' "$DETAIL")
    if ! node "$SCRIPT_DIR/unpack-diagnostic-bundle.mjs" "$OUT_DIR/$FILE" "$OUT_DIR" "$SIZE" "$SHA"; then
      err "framework diagnostic $ARTIFACT_ID failed verification or extraction"
      FAILED=$((FAILED + 1))
    fi
  fi
  note "  saved $FILE"
done < <(jq -r '.report.artifacts[] | [.artifactId, .type, .source, (.contentType // ""), (.filename // "")] | @tsv' "$DETAIL")

echo "$OUT_DIR"
ls -lh "$OUT_DIR" >&2

if [ "$FAILED" -gt 0 ]; then
  err "$FAILED artifact(s) failed to download"
  exit 1
fi
