#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${1:-${MENTRA_WORKSPACE:-}}"
[[ -n "$WORKSPACE" ]] || { printf 'Usage: %s https://workspace.example\n' "$0" >&2; exit 2; }
WORKSPACE="${WORKSPACE%/}"
[[ "$WORKSPACE" =~ ^https://[^/]+$ ]] || {
  printf 'Workspace must be an HTTPS origin without a path: %s\n' "$WORKSPACE" >&2
  exit 2
}

for command in curl jq; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 1; }
done

curl --fail --show-error --silent "$WORKSPACE/healthz" >/dev/null
curl --fail --show-error --silent "$WORKSPACE/ready" >/dev/null
curl --fail --show-error --silent "$WORKSPACE/api/client/min-version" | jq -e '
  def semver: test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$");
  (.data.required | type == "string" and semver) and
  (.data.recommended | type == "string" and semver)
' >/dev/null
manifest="$(curl --fail --show-error --silent "$WORKSPACE/.well-known/mentra-deployment.json")"
if ! jq -e --arg origin "$WORKSPACE" '
  .schemaVersion == 1 and
  (.services.coreUrl | startswith("https://")) and
  .services.runtimeUrl == $origin and
  .auth.mode == "microsoft-entra" and
  (.auth.authorityUrl | test("^https://login\\.microsoftonline\\.com/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")) and
  .features.managedStreams == false and
  .features.nativeMeetings == true and
  (.telemetry | type == "boolean") and
  (.auth.sessionScopes | length > 0 and all(endswith("/mentra.session"))) and
  (.miniapps.managed | type == "array") and
  ((.miniapps.configuration == null) or (.miniapps.configuration | type == "object")) and
  (.branding.logoUrls.light | startswith($origin + "/")) and
  (.branding.logoUrls.dark | startswith($origin + "/"))
' <<<"$manifest" >/dev/null; then
  printf 'Workspace manifest does not match the Mentra Private Deployment v1 contract.\n' >&2
  exit 1
fi

CORE="$(jq -r .services.coreUrl <<<"$manifest")"
curl --fail --show-error --silent "$CORE/healthz" | jq -e '.package == "core"' >/dev/null
curl --fail --show-error --silent "$CORE/ready" >/dev/null
curl --fail --show-error --silent "$CORE/.well-known/jwks.json" | jq -e '.keys | length >= 2' >/dev/null

for url in $(jq -r '[.branding.logoUrls.light,.branding.logoUrls.dark,.links.privacyPolicyUrl,.links.termsOfServiceUrl] | .[]' <<<"$manifest"); do
  curl --fail --show-error --silent --output /dev/null "$url"
done

protected_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST "$WORKSPACE/api/meetings/acs/teams-user-token")"
[[ "$protected_status" == "401" ]] || {
  printf 'Protected meeting endpoint returned HTTP %s without credentials; expected 401.\n' "$protected_status" >&2
  exit 1
}

printf 'Mentra Private Deployment smoke test passed for %s\n' "$WORKSPACE"
