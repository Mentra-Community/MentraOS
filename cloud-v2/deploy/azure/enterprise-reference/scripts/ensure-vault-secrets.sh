#!/usr/bin/env bash
set -euo pipefail

# Create the deployment's signing keys directly in Key Vault, exactly once.
# They exist on this machine only in a private temporary directory that is
# removed on exit. A deployed Core is never given new keys: that would sign
# every employee out and invalidate issued tokens.
if [[ $# -ne 3 ]]; then
  printf 'Usage: %s <key-vault-name> <resource-group> <core-app-name>\n' "$0" >&2
  exit 2
fi
VAULT="$1"
RESOURCE_GROUP="$2"
CORE_NAME="$3"
[[ "$VAULT" =~ ^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$ ]] || { printf 'Invalid Key Vault name\n' >&2; exit 2; }
[[ "$CORE_NAME" =~ ^[a-z][a-z0-9-]{0,30}[a-z0-9]$ ]] || { printf 'Invalid Core app name\n' >&2; exit 2; }
for command in az jq openssl; do
  command -v "$command" >/dev/null || { printf '%s is required\n' "$command" >&2; exit 1; }
done
if [[ -n "${MENTRA_SUBSCRIPTION_ID:-}" ]]; then
  az() { command az "$@" --subscription "$MENTRA_SUBSCRIPTION_ID"; }
fi
NAMES=(refresh-token-pepper mentra-jwt-public-key miniapp-jwt-public-key mentra-jwt-private-key miniapp-jwt-private-key)
RETRY_SECONDS="${MENTRA_VAULT_RETRY_SECONDS:-10}"

ERRORS="$(mktemp "${TMPDIR:-/tmp}/mentra-vault-errors.XXXXXX")"
trap 'rm -f "$ERRORS"' EXIT

# A role assignment made moments ago by bootstrap.bicep can take a few minutes
# to reach Key Vault, and a new vault's name can take a moment to resolve.
# Retry only those; any other refusal is shown at once.
vault_call() {
  local attempt
  for attempt in $(seq 1 30); do
    if "$@" 2>"$ERRORS"; then return 0; fi
    if grep -q 'ForbiddenByRbac' "$ERRORS" || { grep -q 'Forbidden' "$ERRORS" && ! grep -q 'ForbiddenBy' "$ERRORS"; } ||
      grep -Eqi 'getaddrinfo|Name or service not known|nodename nor servname|Failed to establish a new connection' "$ERRORS"; then
      sleep "$RETRY_SECONDS"
      continue
    fi
    if grep -Eq 'ObjectIsDeletedButRecoverable|deleted but recoverable' "$ERRORS"; then
      printf 'Key Vault %s holds a deleted secret with that name. Recover it with "az keyvault secret recover --vault-name %s --name NAME", then run setup again.\n' \
        "$VAULT" "$VAULT" >&2
    fi
    grep '^ERROR' "$ERRORS" | head -n 3 >&2 || true
    return 1
  done
  printf 'Cannot use Key Vault %s yet. Setup gives whoever runs it the Key Vault Secrets Officer role, which can take a few minutes to apply; run setup again shortly.\n' "$VAULT" >&2
  return 1
}

list_names() { az keyvault secret list --vault-name "$VAULT" --query '[].name' --output json; }
PRESENT="$(vault_call list_names)"
MISSING=()
for name in "${NAMES[@]}"; do
  jq -e --arg name "$name" 'index($name) != null' <<<"$PRESENT" >/dev/null || MISSING+=("$name")
done
if [[ ${#MISSING[@]} -eq 0 ]]; then
  printf 'Signing keys are in Key Vault %s.\n' "$VAULT" >&2
  exit 0
fi
# A failed lookup stops here; it must never read as "no Core yet".
CORE_COUNT="$(az containerapp list --resource-group "$RESOURCE_GROUP" --query "length([?name=='$CORE_NAME'])" --output tsv)"
if [[ "$CORE_COUNT" != 0 ]]; then
  printf 'Key Vault %s is missing %s, but Core already runs with the original keys. Recover them with "az keyvault secret recover --vault-name %s --name NAME". Setup never replaces the keys of a running deployment.\n' \
    "$VAULT" "${MISSING[*]}" "$VAULT" >&2
  exit 1
fi

# Nothing has used the keys yet, so an interrupted first run is completed
# by writing one fresh, matching set.
umask 077
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR" "$ERRORS"' EXIT
key_body() { sed '/^-----/d' "$1" | tr -d '\r\n'; }
openssl genpkey -algorithm ED25519 -out "$TEMP_DIR/access.pem"
openssl pkey -in "$TEMP_DIR/access.pem" -pubout -out "$TEMP_DIR/access.pub"
openssl genpkey -algorithm ED25519 -out "$TEMP_DIR/miniapp.pem"
openssl pkey -in "$TEMP_DIR/miniapp.pem" -pubout -out "$TEMP_DIR/miniapp.pub"
openssl rand -base64 48 | tr -d '\r\n' > "$TEMP_DIR/refresh-token-pepper"
key_body "$TEMP_DIR/access.pub" > "$TEMP_DIR/mentra-jwt-public-key"
key_body "$TEMP_DIR/miniapp.pub" > "$TEMP_DIR/miniapp-jwt-public-key"
key_body "$TEMP_DIR/access.pem" > "$TEMP_DIR/mentra-jwt-private-key"
key_body "$TEMP_DIR/miniapp.pem" > "$TEMP_DIR/miniapp-jwt-private-key"
set_secret() {
  # The value is read from a file, never passed as a command-line argument.
  az keyvault secret set --vault-name "$VAULT" --name "$1" --file "$TEMP_DIR/$1" --encoding utf-8 \
    --content-type text/plain --output none
}
for name in "${NAMES[@]}"; do
  [[ -s "$TEMP_DIR/$name" ]] || { printf 'Key generation produced an empty %s\n' "$name" >&2; exit 1; }
  vault_call set_secret "$name"
done
printf 'Created signing keys in Key Vault %s.\n' "$VAULT" >&2
