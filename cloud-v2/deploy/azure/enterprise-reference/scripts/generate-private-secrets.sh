#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /secure/path/mentra-private-secrets.json\n' "$0" >&2
  exit 2
fi

OUTPUT="$1"
[[ ! -e "$OUTPUT" ]] || {
  printf 'Refusing to overwrite existing secret file: %s\n' "$OUTPUT" >&2
  exit 1
}

for command in jq openssl; do
  command -v "$command" >/dev/null || {
    printf '%s is required\n' "$command" >&2
    exit 1
  }
done

umask 077
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

key_body() {
  sed '/^-----/d' "$1" | tr -d '\r\n'
}

openssl genpkey -algorithm ED25519 -out "$TEMP_DIR/access-private.pem" 2>/dev/null
openssl pkey -in "$TEMP_DIR/access-private.pem" -pubout -out "$TEMP_DIR/access-public.pem" 2>/dev/null
openssl genpkey -algorithm ED25519 -out "$TEMP_DIR/miniapp-private.pem" 2>/dev/null
openssl pkey -in "$TEMP_DIR/miniapp-private.pem" -pubout -out "$TEMP_DIR/miniapp-public.pem" 2>/dev/null

jq -n \
  --arg refreshTokenPepper "$(openssl rand -base64 48 | tr -d '\r\n')" \
  --arg mentraJwtPrivateKey "$(key_body "$TEMP_DIR/access-private.pem")" \
  --arg mentraJwtPublicKey "$(key_body "$TEMP_DIR/access-public.pem")" \
  --arg miniappJwtPrivateKey "$(key_body "$TEMP_DIR/miniapp-private.pem")" \
  --arg miniappJwtPublicKey "$(key_body "$TEMP_DIR/miniapp-public.pem")" \
  '{refreshTokenPepper:$refreshTokenPepper,mentraJwtPrivateKey:$mentraJwtPrivateKey,mentraJwtPublicKey:$mentraJwtPublicKey,miniappJwtPrivateKey:$miniappJwtPrivateKey,miniappJwtPublicKey:$miniappJwtPublicKey}' \
  > "$OUTPUT"

printf 'Created %s with mode 0600. Import it into the approved secret manager, then retain or destroy this copy according to policy.\n' "$OUTPUT"
