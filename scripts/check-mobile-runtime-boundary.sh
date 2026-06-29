#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALLOWLIST="$ROOT_DIR/mobile/boundary-allowlist.txt"

if ! command -v rg >/dev/null 2>&1; then
  echo "error: ripgrep (rg) is required" >&2
  exit 2
fi

if [[ ! -f "$ALLOWLIST" ]]; then
  echo "error: missing allowlist: $ALLOWLIST" >&2
  exit 2
fi

TMP_ACTUAL="$(mktemp)"
TMP_ALLOWLIST="$(mktemp)"
TMP_NEW="$(mktemp)"
trap 'rm -f "$TMP_ACTUAL" "$TMP_ALLOWLIST" "$TMP_NEW"' EXIT

cd "$ROOT_DIR"

rg -l \
  'from ["'\'']@/stores/glasses|@/stores/gallerySync|useGlassesStore|useGallerySyncStore|waitForGlassesState|getGlasesInfoPartial|selectGlassesConnected|selectGlassesReady|toolkit\.stores\.glasses|toolkit\.stores\.gallerySync' \
  mobile/src \
  mobile/assets \
  -g '*.ts' \
  -g '*.tsx' \
  --glob '!**/__tests__/**' \
  --glob '!**/*.test.ts' \
  --glob '!**/*.test.tsx' \
  --glob '!**/*.spec.ts' \
  --glob '!**/*.spec.tsx' \
  | sort >"$TMP_ACTUAL" || true

grep -vE '^[[:space:]]*(#|$)' "$ALLOWLIST" | sort >"$TMP_ALLOWLIST" || true

comm -23 "$TMP_ACTUAL" "$TMP_ALLOWLIST" >"$TMP_NEW"

if [[ -s "$TMP_NEW" ]]; then
  echo "New host-side raw glasses/gallery store usage detected:" >&2
  cat "$TMP_NEW" >&2
  echo >&2
  echo "Move the code onto a toolkit facade, or add a temporary allowlist entry with a migration plan." >&2
  exit 1
fi

echo "mobile runtime boundary check passed ($(wc -l <"$TMP_ACTUAL" | tr -d ' ') allowlisted files)"
