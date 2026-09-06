#!/usr/bin/env bash
set -euo pipefail

# `az acr import` runs as the signed-in Azure CLI identity. That identity needs
# a role that permits import on the target registry (Contributor or a custom
# role granting Microsoft.ContainerRegistry/registries/importImage/action) and,
# for a private source registry, pull credentials on the source. Supply source
# credentials through SOURCE_REGISTRY_USERNAME and SOURCE_REGISTRY_PASSWORD
# (never argv) when the source is not the public GHCR package.
#
# Only the final digest-pinned reference goes to stdout; status goes to stderr.

if [[ $# -ne 3 ]]; then
  printf 'Usage: %s <customer-acr-name> <source-image@sha256:digest> <release-tag>\n' "$0" >&2
  printf 'Optional: SOURCE_REGISTRY_USERNAME and SOURCE_REGISTRY_PASSWORD for a private source registry.\n' >&2
  exit 2
fi

CUSTOMER_ACR="$1"
SOURCE_IMAGE="$2"
RELEASE_TAG="$3"
SOURCE_REGISTRY_USERNAME="${SOURCE_REGISTRY_USERNAME:-}"
SOURCE_REGISTRY_PASSWORD="${SOURCE_REGISTRY_PASSWORD:-}"

[[ "$SOURCE_IMAGE" == *@sha256:* ]] || { printf 'Source image must be pinned by sha256 digest.\n' >&2; exit 1; }
[[ "$RELEASE_TAG" =~ ^[A-Za-z0-9._-]+$ ]] || { printf 'Release tag contains unsupported characters.\n' >&2; exit 1; }
[[ -z "$SOURCE_REGISTRY_USERNAME" && -z "$SOURCE_REGISTRY_PASSWORD" || -n "$SOURCE_REGISTRY_USERNAME" && -n "$SOURCE_REGISTRY_PASSWORD" ]] || {
  printf 'SOURCE_REGISTRY_USERNAME and SOURCE_REGISTRY_PASSWORD must be set together.\n' >&2
  exit 1
}

IMPORT_ARGS=(
  --name "$CUSTOMER_ACR"
  --source "$SOURCE_IMAGE"
  --image "mentra-cloud-enterprise:$RELEASE_TAG"
)
if [[ -n "$SOURCE_REGISTRY_USERNAME" ]]; then
  IMPORT_ARGS+=(--username "$SOURCE_REGISTRY_USERNAME" --password "$SOURCE_REGISTRY_PASSWORD")
fi

printf 'Importing %s into %s as mentra-cloud-enterprise:%s\n' "$SOURCE_IMAGE" "$CUSTOMER_ACR" "$RELEASE_TAG" >&2
az acr import "${IMPORT_ARGS[@]}" 1>&2

IMPORTED_DIGEST="$(az acr repository show \
  --name "$CUSTOMER_ACR" \
  --image "mentra-cloud-enterprise:$RELEASE_TAG" \
  --query digest -o tsv)"
EXPECTED_DIGEST="${SOURCE_IMAGE##*@}"
[[ "$IMPORTED_DIGEST" == "$EXPECTED_DIGEST" ]] || {
  printf 'Imported digest mismatch: expected %s, got %s\n' "$EXPECTED_DIGEST" "$IMPORTED_DIGEST" >&2
  exit 1
}
printf '%s.azurecr.io/mentra-cloud-enterprise@%s\n' "$CUSTOMER_ACR" "$IMPORTED_DIGEST"
