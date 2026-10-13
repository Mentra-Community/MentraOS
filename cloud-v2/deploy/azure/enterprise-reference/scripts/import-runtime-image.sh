#!/usr/bin/env bash
set -euo pipefail

# Never replace an existing release tag. Matching imports are safe to resume.
# Private source credentials go through an owner-only ARM request file.
if [[ $# -ne 3 ]]; then
  printf 'Usage: %s <customer-acr-name> <source-image@sha256:digest> <release-tag>\n' "$0" >&2
  exit 2
fi
CUSTOMER_ACR="$1"
SOURCE_IMAGE="$2"
RELEASE_TAG="$3"
[[ "$CUSTOMER_ACR" =~ ^[a-zA-Z0-9]{5,50}$ ]] || exit 2
[[ "$SOURCE_IMAGE" =~ ^[a-z0-9]+([.-][a-z0-9]+)*(:[0-9]+)?/[a-z0-9]+([._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$ ]] || {
  printf 'Source must be a registry/repository image pinned by sha256.\n' >&2; exit 2;
}
[[ "$RELEASE_TAG" =~ ^[A-Za-z0-9._-]+$ ]] || exit 2
[[ -z "${SOURCE_REGISTRY_USERNAME:-}" && -z "${SOURCE_REGISTRY_PASSWORD:-}" || -n "${SOURCE_REGISTRY_USERNAME:-}" && -n "${SOURCE_REGISTRY_PASSWORD:-}" ]] || {
  printf 'Source username and password must be supplied together.\n' >&2; exit 2;
}
if [[ -n "${MENTRA_SUBSCRIPTION_ID:-}" ]]; then
  az() { command az "$@" --subscription "$MENTRA_SUBSCRIPTION_ID"; }
fi
EXPECTED_DIGEST="${SOURCE_IMAGE##*@}"
SOURCE_REGISTRY="${SOURCE_IMAGE%%/*}"
ERRORS="$(mktemp "${TMPDIR:-/tmp}/mentra-acr-errors.XXXXXX")"
trap 'rm -f "$ERRORS" "${REQUEST:-}"' EXIT

# The registry's own address: a registry created moments ago may not resolve
# yet, and resolvers then cache that failure for several minutes. Retry only it.
registry_digest() {
  local attempt
  for attempt in $(seq 1 "${MENTRA_ACR_DNS_ATTEMPTS:-60}"); do
    if az acr repository show --name "$CUSTOMER_ACR" --image "mentra-cloud-enterprise:$RELEASE_TAG" \
      --query digest -o tsv 2>"$ERRORS"; then
      return 0
    fi
    if ! grep -Eq 'Could not connect to the registry login server|MANIFEST_UNKNOWN' "$ERRORS"; then
      cat "$ERRORS" >&2
      return 1
    fi
    [[ "$attempt" == 1 ]] && printf 'Waiting for the registry to become reachable...\n' >&2
    sleep "${MENTRA_ACR_DNS_RETRY_SECONDS:-10}"
  done
  cat "$ERRORS" >&2
  return 1
}

printf 'Importing immutable release into %s\n' "$CUSTOMER_ACR" >&2
if [[ -n "${SOURCE_REGISTRY_USERNAME:-}" ]]; then
  umask 077
  REQUEST="$(mktemp "${TMPDIR:-/tmp}/mentra-acr-import.XXXXXX")"
  # jq reads the environment itself; secrets never appear in process arguments.
  jq -n --arg source "$SOURCE_IMAGE" --arg tag "$RELEASE_TAG" --arg registry "$SOURCE_REGISTRY" '{
    source:{registryUri:$registry,sourceImage:($source|split("/")|.[1:]|join("/")),
      credentials:{username:env.SOURCE_REGISTRY_USERNAME,password:env.SOURCE_REGISTRY_PASSWORD}},
    targetTags:[("mentra-cloud-enterprise:"+$tag)],mode:"NoForce"
  }' > "$REQUEST"
  REGISTRY_ID="$(az acr show --name "$CUSTOMER_ACR" --query id -o tsv)"
  if ! az rest --method post --url "https://management.azure.com${REGISTRY_ID}/importImage?api-version=2023-07-01" \
    --body "@$REQUEST" --output none 2>"$ERRORS" && ! grep -q 'already exists in target registry' "$ERRORS"; then
    cat "$ERRORS" >&2
    exit 1
  fi
  # This ARM request completes asynchronously; wait until the exact digest is readable.
  IMPORTED_DIGEST="$(registry_digest)" || exit 1
# An import runs in Azure, so it works before a brand-new registry's address
# resolves, and NoForce never replaces a tag. Importing by digest copies exactly
# that manifest.
elif az acr import --name "$CUSTOMER_ACR" --source "$SOURCE_IMAGE" --image "mentra-cloud-enterprise:$RELEASE_TAG" \
  --output none 2>"$ERRORS"; then
  IMPORTED_DIGEST="$EXPECTED_DIGEST"
elif grep -q 'already exists in target registry' "$ERRORS"; then
  # A rerun: the tag exists, so the registry is old enough to resolve. It must be this release.
  IMPORTED_DIGEST="$(registry_digest)" || exit 1
else
  cat "$ERRORS" >&2
  exit 1
fi
[[ "$IMPORTED_DIGEST" == "$EXPECTED_DIGEST" ]] || {
  printf 'Release tag %s already points to another digest; choose a different release tag.\n' "$RELEASE_TAG" >&2
  exit 1
}
printf '%s.azurecr.io/mentra-cloud-enterprise@%s\n' "$CUSTOMER_ACR" "$IMPORTED_DIGEST"
