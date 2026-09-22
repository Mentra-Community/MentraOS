#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /secure/path/mentra-private-secrets.json\n' "$0" >&2
  exit 2
fi

OUTPUT="$1"
[[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] || {
  printf 'Refusing to overwrite existing secret file: %s\n' "$OUTPUT" >&2
  exit 1
}
OUTPUT_DIR="$(dirname -- "$OUTPUT")"
OUTPUT_NAME="$(basename -- "$OUTPUT")"
[[ -d "$OUTPUT_DIR" ]] || {
  printf 'Output directory does not exist: %s\n' "$OUTPUT_DIR" >&2
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
TEMP_OUTPUT="$(mktemp "$OUTPUT_DIR/.${OUTPUT_NAME}.tmp.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"; rm -f "$TEMP_OUTPUT"' EXIT

key_body() {
  sed '/^-----/d' "$1" | tr -d '\r\n'
}

openssl genpkey -algorithm ED25519 -out "$TEMP_DIR/access-private.pem" 2>/dev/null
openssl pkey -in "$TEMP_DIR/access-private.pem" -pubout -out "$TEMP_DIR/access-public.pem" 2>/dev/null
openssl genpkey -algorithm ED25519 -out "$TEMP_DIR/miniapp-private.pem" 2>/dev/null
openssl pkey -in "$TEMP_DIR/miniapp-private.pem" -pubout -out "$TEMP_DIR/miniapp-public.pem" 2>/dev/null

openssl rand -base64 48 | tr -d '\r\n' > "$TEMP_DIR/refresh-token-pepper"
key_body "$TEMP_DIR/access-private.pem" > "$TEMP_DIR/access-private.body"
key_body "$TEMP_DIR/access-public.pem" > "$TEMP_DIR/access-public.body"
key_body "$TEMP_DIR/miniapp-private.pem" > "$TEMP_DIR/miniapp-private.body"
key_body "$TEMP_DIR/miniapp-public.pem" > "$TEMP_DIR/miniapp-public.body"

for secret_file in \
  "$TEMP_DIR/refresh-token-pepper" \
  "$TEMP_DIR/access-private.body" \
  "$TEMP_DIR/access-public.body" \
  "$TEMP_DIR/miniapp-private.body" \
  "$TEMP_DIR/miniapp-public.body"; do
  [[ -s "$secret_file" ]] || { printf 'Secret generation produced an empty value\n' >&2; exit 1; }
done

jq -n \
  --rawfile refreshTokenPepper "$TEMP_DIR/refresh-token-pepper" \
  --rawfile mentraJwtPrivateKey "$TEMP_DIR/access-private.body" \
  --rawfile mentraJwtPublicKey "$TEMP_DIR/access-public.body" \
  --rawfile miniappJwtPrivateKey "$TEMP_DIR/miniapp-private.body" \
  --rawfile miniappJwtPublicKey "$TEMP_DIR/miniapp-public.body" \
  '{refreshTokenPepper:$refreshTokenPepper,mentraJwtPrivateKey:$mentraJwtPrivateKey,mentraJwtPublicKey:$mentraJwtPublicKey,miniappJwtPrivateKey:$miniappJwtPrivateKey,miniappJwtPublicKey:$miniappJwtPublicKey}' \
  > "$TEMP_OUTPUT"
chmod 0600 "$TEMP_OUTPUT"

# Hard-link publication is atomic and fails if OUTPUT appeared concurrently or
# is a dangling symlink. Both paths are in the same directory/filesystem.
if ! ln "$TEMP_OUTPUT" "$OUTPUT"; then
  printf 'Refusing to overwrite existing secret file: %s\n' "$OUTPUT" >&2
  exit 1
fi
rm -f "$TEMP_OUTPUT"

printf 'Created %s with mode 0600. Import it into the approved secret manager, then retain or destroy this copy according to policy.\n' "$OUTPUT"
