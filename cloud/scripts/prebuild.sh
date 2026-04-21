#!/usr/bin/env bash
#
# prebuild.sh — Local dry-run of the CI/CD build pipeline.
#
# Mirrors the exact build sequence in docker/Dockerfile.porter:
#   types → display-utils → sdk → utils → cloud
#
# Run from the cloud/ directory:
#   ./scripts/prebuild.sh
#
# Flags:
#   --clean   rm -rf dist in every package before building
#   --quick   skip types & display-utils (only sdk + cloud)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Flags ────────────────────────────────────────────────────────────────────
CLEAN=false
QUICK=false
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=true ;;
    --quick) QUICK=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

FAILED=()
SKIPPED=()
PASS=()

build_package() {
  local name="$1"
  local dir="$CLOUD_ROOT/packages/$name"

  if [[ ! -d "$dir" ]]; then
    echo -e "${YELLOW}⏭  packages/$name — not found, skipping${NC}"
    SKIPPED+=("$name")
    return 0
  fi

  echo -e "${CYAN}⚙️  Building packages/$name...${NC}"

  if $CLEAN; then
    rm -rf "$dir/dist" "$dir/tsconfig.tsbuildinfo" 2>/dev/null || true
  fi

  if (cd "$dir" && bun run build 2>&1); then
    echo -e "${GREEN}✅ packages/$name${NC}"
    PASS+=("$name")
  else
    echo -e "${RED}❌ packages/$name FAILED${NC}"
    FAILED+=("$name")
    return 1
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}🚀 prebuild — local CI/CD dry-run${NC}"
echo -e "${CYAN}   mirrors docker/Dockerfile.porter build sequence${NC}"
echo ""

START=$(date +%s)

if $QUICK; then
  echo -e "${YELLOW}--quick: skipping types & display-utils${NC}"
  echo ""
  SKIPPED+=("types" "display-utils")
else
  build_package "types"
  build_package "display-utils"
fi

build_package "sdk"
build_package "utils"
build_package "cloud"

END=$(date +%s)
ELAPSED=$((END - START))

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────"
echo -e "  ${GREEN}Passed:  ${#PASS[@]}${NC}  (${PASS[*]:-none})"
if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  echo -e "  ${YELLOW}Skipped: ${#SKIPPED[@]}${NC}  (${SKIPPED[*]})"
fi
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo -e "  ${RED}Failed:  ${#FAILED[@]}${NC}  (${FAILED[*]})"
fi
echo "  Time:    ${ELAPSED}s"
echo "─────────────────────────────────────────"

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo ""
  echo -e "${RED}❌ Build would fail in CI. Fix errors above before pushing.${NC}"
  exit 1
else
  echo ""
  echo -e "${GREEN}🎉 All packages built successfully — safe to push.${NC}"
  exit 0
fi
