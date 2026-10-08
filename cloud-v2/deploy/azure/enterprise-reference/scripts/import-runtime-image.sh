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
# Listing the repository also verifies target access. A failed lookup is not
# evidence that the tag is absent, and must not trigger a blind import. A
# registry created moments ago may not resolve yet, and resolvers cache that for
# up to five minutes (the azurecr.io negative TTL), so retry only that failure.
LIST_ERRORS="$(mktemp "${TMPDIR:-/tmp}/mentra-acr-list.XXXXXX")"
for attempt in $(seq 1 "${MENTRA_ACR_DNS_ATTEMPTS:-40}"); do
  if TAGS="$(az acr repository list --name "$CUSTOMER_ACR" -o json 2>"$LIST_ERRORS")"; then
    break
  fi
  grep -q 'Could not connect to the registry login server' "$LIST_ERRORS" && [[ "$attempt" != "${MENTRA_ACR_DNS_ATTEMPTS:-40}" ]] || {
    cat "$LIST_ERRORS" >&2
    rm -f "$LIST_ERRORS"
    exit 1
  }
  [[ "$attempt" == 1 ]] && printf 'Waiting for the new registry to become reachable...\n' >&2
  sleep "${MENTRA_ACR_DNS_RETRY_SECONDS:-10}"
done
rm -f "$LIST_ERRORS"
if jq -e 'index("mentra-cloud-enterprise") != null' <<<"$TAGS" >/dev/null; then
  TAGS="$(az acr repository show-tags --name "$CUSTOMER_ACR" --repository mentra-cloud-enterprise -o json)"
  if jq -e --arg tag "$RELEASE_TAG" 'index($tag) != null' <<<"$TAGS" >/dev/null; then
    IMPORTED_DIGEST="$(az acr repository show --name "$CUSTOMER_ACR" --image "mentra-cloud-enterprise:$RELEASE_TAG" --query digest -o tsv)"
    [[ "$IMPORTED_DIGEST" == "$EXPECTED_DIGEST" ]] || {
      printf 'Release tag already points to another digest; choose a different release tag.\n' >&2; exit 1;
    }
    printf '%s.azurecr.io/mentra-cloud-enterprise@%s\n' "$CUSTOMER_ACR" "$IMPORTED_DIGEST"
    exit 0
  fi
fi
printf 'Importing immutable release into %s\n' "$CUSTOMER_ACR" >&2
if [[ -n "${SOURCE_REGISTRY_USERNAME:-}" ]]; then
  umask 077
  REQUEST="$(mktemp "${TMPDIR:-/tmp}/mentra-acr-import.XXXXXX")"
  trap 'rm -f "$REQUEST"' EXIT
  # jq reads the environment itself; secrets never appear in process arguments.
  jq -n --arg source "$SOURCE_IMAGE" --arg tag "$RELEASE_TAG" --arg registry "$SOURCE_REGISTRY" '{
    source:{registryUri:$registry,sourceImage:($source|split("/")|.[1:]|join("/")),
      credentials:{username:env.SOURCE_REGISTRY_USERNAME,password:env.SOURCE_REGISTRY_PASSWORD}},
    targetTags:[("mentra-cloud-enterprise:"+$tag)],mode:"NoForce"
  }' > "$REQUEST"
  REGISTRY_ID="$(az acr show --name "$CUSTOMER_ACR" --query id -o tsv)"
  az rest --method post --url "https://management.azure.com${REGISTRY_ID}/importImage?api-version=2023-07-01" --body "@$REQUEST" --output none
  # The ARM operation can be asynchronous; wait for the exact digest below.
else
  az acr import --name "$CUSTOMER_ACR" --source "$SOURCE_IMAGE" --image "mentra-cloud-enterprise:$RELEASE_TAG" --output none
fi
for attempt in $(seq 1 30); do
  if IMPORTED_DIGEST="$(az acr repository show --name "$CUSTOMER_ACR" --image "mentra-cloud-enterprise:$RELEASE_TAG" --query digest -o tsv 2>/dev/null)"; then
    [[ "$IMPORTED_DIGEST" == "$EXPECTED_DIGEST" ]] || { printf 'Imported digest mismatch.\n' >&2; exit 1; }
    printf '%s.azurecr.io/mentra-cloud-enterprise@%s\n' "$CUSTOMER_ACR" "$IMPORTED_DIGEST"
    exit 0
  fi
  sleep 10
done
printf 'Import has not become readable. Resume after checking the Azure operation.\n' >&2
exit 1
