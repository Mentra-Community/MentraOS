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

for command in jq openssl python3; do
  command -v "$command" >/dev/null || {
    printf '%s is required\n' "$command" >&2
    exit 1
  }
done

umask 077
TEMP_DIR="$(mktemp -d)"
TEMP_OUTPUT="$(mktemp "$OUTPUT_DIR/.${OUTPUT_NAME}.tmp.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"; rm -f "$TEMP_OUTPUT"' EXIT
chmod 0600 "$TEMP_OUTPUT"
python3 - "$TEMP_OUTPUT" <<'PYMODE'
import os, stat, sys
value = os.stat(sys.argv[1])
if value.st_uid != os.getuid() or stat.S_IMODE(value.st_mode) & 0o077:
    sys.exit('This filesystem cannot protect secret files. In persistent Azure Cloud Shell use a folder under $HOME, not the clouddrive SMB share.')
PYMODE

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

# Persistent Cloud Shell HOME supports POSIX permissions and hard links; its
# clouddrive SMB share was rejected above before generating keys. Publish a
# complete inode without replacing a file, even if a non-cooperating writer
# creates the destination concurrently. A killed generator leaves no partial key.
python3 - "$TEMP_OUTPUT" "$OUTPUT" <<'PYPUBLISH'
import os, sys
source, output = sys.argv[1:]
with open(source, 'rb') as stream:
    os.fsync(stream.fileno())
try:
    os.link(source, output)
except FileExistsError:
    sys.exit('Refusing to overwrite existing secret file: ' + output)
except OSError:
    sys.exit('This filesystem cannot atomically publish secrets without overwriting. Use persistent Cloud Shell HOME or a local POSIX filesystem.')
os.unlink(source)
PYPUBLISH

printf 'Created %s with mode 0600. Import it into the approved secret manager, then retain or destroy this copy according to policy.\n' "$OUTPUT"
