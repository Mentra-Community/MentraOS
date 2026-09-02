#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  printf 'Usage: %s <customer-acr-name> <source-image@sha256:digest> <release-tag>\n' "$0" >&2
  exit 2
fi

CUSTOMER_ACR="$1"
SOURCE_IMAGE="$2"
RELEASE_TAG="$3"

[[ "$SOURCE_IMAGE" == *@sha256:* ]] || { printf 'Source image must be pinned by sha256 digest.\n' >&2; exit 1; }
[[ "$RELEASE_TAG" =~ ^[A-Za-z0-9._-]+$ ]] || { printf 'Release tag contains unsupported characters.\n' >&2; exit 1; }

az acr import \
  --name "$CUSTOMER_ACR" \
  --source "$SOURCE_IMAGE" \
  --image "mentra-runtime-enterprise:$RELEASE_TAG"

IMPORTED_DIGEST="$(az acr repository show \
  --name "$CUSTOMER_ACR" \
  --image "mentra-runtime-enterprise:$RELEASE_TAG" \
  --query digest -o tsv)"
EXPECTED_DIGEST="${SOURCE_IMAGE##*@}"
[[ "$IMPORTED_DIGEST" == "$EXPECTED_DIGEST" ]] || {
  printf 'Imported digest mismatch: expected %s, got %s\n' "$EXPECTED_DIGEST" "$IMPORTED_DIGEST" >&2
  exit 1
}
printf '%s.azurecr.io/mentra-runtime-enterprise@%s\n' "$CUSTOMER_ACR" "$IMPORTED_DIGEST"
