#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${1:-${MENTRA_WORKSPACE:-}}"
[[ -n "$WORKSPACE" ]] || { printf 'Usage: %s https://workspace.example\n' "$0" >&2; exit 2; }
WORKSPACE="${WORKSPACE%/}"
[[ "$WORKSPACE" =~ ^https://[^/]+$ ]] || {
  printf 'Workspace must be an HTTPS origin without a path: %s\n' "$WORKSPACE" >&2
  exit 2
}

for command in curl jq python3; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 1; }
done

# Bound every request, including downloads and authentication checks. A failed
# deployment must return actionable evidence instead of hanging on ingress.
request() { curl --connect-timeout 10 --max-time 60 "$@"; }
wait_for_health() {
  local origin="$1" label="$2" attempt
  for attempt in $(seq 1 30); do
    if curl --connect-timeout 5 --max-time 10 --fail --silent "$origin/ready" >/dev/null; then
      return
    fi
    sleep 10
  done
  printf '%s did not become healthy. Check Container Apps revisions and Cosmos DB diagnostics, then run verify again.\n' "$label" >&2
  return 1
}

wait_for_health "$WORKSPACE" Runtime
request --fail --show-error --silent "$WORKSPACE/healthz" >/dev/null
request --fail --show-error --silent "$WORKSPACE/ready" >/dev/null
request --fail --show-error --silent "$WORKSPACE/api/client/min-version" | jq -e '
  def semver: test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$");
  (.data.required | type == "string" and semver) and
  (.data.recommended | type == "string" and semver)
' >/dev/null
manifest="$(request --fail --show-error --silent "$WORKSPACE/.well-known/mentra-deployment.json")"
if ! jq -e --arg origin "$WORKSPACE" --arg requireCall "${MENTRA_REQUIRE_CALL:-false}" '
  .schemaVersion == 1 and
  (.services.coreUrl | startswith("https://")) and
  .services.runtimeUrl == $origin and
  .auth.mode == "microsoft-entra" and
  (.auth.authorityUrl | test("^https://login\\.microsoftonline\\.com/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")) and
  .features.managedStreams == false and
  .features.nativeMeetings == true and
  (.telemetry | type == "boolean") and
  (.auth.sessionScopes | length > 0 and all(endswith("/mentra.session"))) and
  (.miniapps.managed | type == "array" and (if $requireCall == "true" then any(.packageName == "com.mentra.call") else true end)) and
  ((.miniapps.configuration == null) or (.miniapps.configuration | type == "object")) and
  (.branding.logoUrls.light | startswith($origin + "/")) and
  (.branding.logoUrls.dark | startswith($origin + "/"))
' <<<"$manifest" >/dev/null; then
  printf 'Workspace manifest does not match the Mentra Private Deployment v1 contract.\n' >&2
  exit 1
fi

# Verify what phones download, including the exact published ZIP bytes.
BUNDLE_DIR="$(mktemp -d)"
trap 'rm -rf "$BUNDLE_DIR"' EXIT
while IFS=$'\t' read -r package version url expected; do
  [[ "$url" == "$WORKSPACE/miniapps/"* && "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || {
    printf 'Managed miniapp must use the pinned workspace bundle and SHA-256.\n' >&2
    exit 1
  }
  request --fail --show-error --silent --max-filesize 67108864 --output "$BUNDLE_DIR/bundle.zip" "$url"
  python3 - "$BUNDLE_DIR/bundle.zip" "$expected" <<'PYVERIFY'
import hashlib, sys, zipfile
from pathlib import Path
path, expected = sys.argv[1:]
if Path(path).stat().st_size > 64 * 1024 * 1024:
    sys.exit('Managed miniapp ZIP exceeds download limit')
if hashlib.sha256(Path(path).read_bytes()).hexdigest() != expected.lower():
    sys.exit('Managed miniapp ZIP checksum mismatch')
with zipfile.ZipFile(path) as archive:
    entries = archive.infolist()
    if len(entries) > 4096:
        sys.exit('Managed miniapp ZIP contains too many files')
    total = 0
    for entry in entries:
        expanded = 0
        with archive.open(entry) as stream:
            while True:
                chunk = stream.read(64 * 1024)
                if not chunk:
                    break
                expanded += len(chunk)
                total += len(chunk)
                if expanded > 32 * 1024 * 1024 or total > 64 * 1024 * 1024:
                    sys.exit('Managed miniapp ZIP exceeds expansion limit')
PYVERIFY
done < <(jq -r '.miniapps.managed[] | [.packageName,.version,.bundleUrl,.sha256] | @tsv' <<<"$manifest")

CORE="$(jq -r .services.coreUrl <<<"$manifest")"
wait_for_health "$CORE" Core
request --fail --show-error --silent "$CORE/healthz" | jq -e '.package == "core"' >/dev/null
request --fail --show-error --silent "$CORE/ready" >/dev/null
request --fail --show-error --silent "$CORE/.well-known/jwks.json" | jq -e '.keys | length >= 2' >/dev/null

for url in $(jq -r '[.branding.logoUrls.light,.branding.logoUrls.dark,.links.privacyPolicyUrl,.links.termsOfServiceUrl] | .[]' <<<"$manifest"); do
  request --fail --show-error --silent --output /dev/null "$url"
done

protected_status="$(request --silent --output /dev/null --write-out '%{http_code}' \
  --request POST "$WORKSPACE/api/meetings/acs/token")"
[[ "$protected_status" == "401" ]] || {
  printf 'Protected meeting endpoint returned HTTP %s without credentials; expected 401.\n' "$protected_status" >&2
  exit 1
}

printf 'Mentra Private Deployment smoke test passed for %s\n' "$WORKSPACE"
