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
  'from ["'\'']@/stores/glasses|@/stores/gallerySync|@/stores/settings|@/stores/bluetoothSettingKeys|@/stores/display|@/stores/core|@/stores/connection|@/stores/cloudClientStatus|useGlassesStore|useGallerySyncStore|useSettingsStore|useDisplayStore|useCoreStore|useConnectionStore|useCloudClientStatusStore|useAppStatusStore|waitForGlassesState|getGlasesInfoPartial|selectGlassesConnected|selectGlassesReady|engine\.stores\.glasses|engine\.stores\.gallerySync' \
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
  echo "Move the code onto a engine facade, or add a temporary allowlist entry with a migration plan." >&2
  exit 1
fi

echo "mobile runtime boundary check passed ($(wc -l <"$TMP_ACTUAL" | tr -d ' ') allowlisted files)"

# ---------------------------------------------------------------------------
# Report-only patterns (next boundary campaigns; see
# cloud-v2/docs/issues/020-glasses-status-boundary/integration-review.md §D/§F).
# These do NOT fail the check yet — they measure the burn-down surface. Turn
# each into a failing pattern above once its migration completes.
# ---------------------------------------------------------------------------
report_count() {
  local label="$1" pattern="$2"
  local count
  # rg exits 1 on zero matches; under `set -euo pipefail` that would abort the
  # script exactly when a burn-down hits 0 — swallow it so 0 reports as 0.
  count="$({ rg -l "$pattern" mobile/src \
    -g '*.ts' -g '*.tsx' \
    --glob '!**/__tests__/**' \
    --glob '!**/*.test.ts' \
    --glob '!**/*.test.tsx' \
    --glob '!**/test-utils/**' \
    2>/dev/null || true; } | wc -l | tr -d ' ')"
  echo "  [report-only] ${label}: ${count} files"
}

echo "boundary burn-down (informational):"
# Raw stores are only importable through the private MentraOS host package now
# (directly or through the @/stores/* shims, which re-export from it). The hook-name
# pattern counts every consumer regardless of route, so the number stays
# comparable across the burn-down campaign.
# ALL raw engine stores graduated to FAILING patterns above (burn-down slices
# 1-5 complete); the allowlisted Cloud V1 files + the dev-tooling fallback are
# the only sanctioned users until tier 5 retires the former.
report_count "private engine host importers" 'from "@mentra/engine-host-internal"'
report_count "private engine host devtools importers" 'from "@mentra/engine-host-internal/devtools"'
report_count "engine.stores escape hatch (deleted; should stay 0)" 'engine\.stores\.'
report_count "bluetooth-sdk internal surface in host" '@mentra/bluetooth-sdk-internal|@mentra/bluetooth-sdk/internal'
report_count "flat engine OTA helpers in host" 'checkBesUpdate|findMatchingMtkPatch|fetchVersionInfo|getAsgOtaVersionUrl'
