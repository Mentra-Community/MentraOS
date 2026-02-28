#!/bin/bash

# test-ci-build.sh
# Simulates GitHub Actions CI build locally to test before pushing
# Run from cloud/ directory: ./test-ci-build.sh

set -e  # Exit on any error

echo "🧪 Simulating CI Build Locally"
echo "=============================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Track overall success
BUILD_SUCCESS=true

# Function to run a step and report result
run_step() {
    local step_name=$1
    local command=$2
    local working_dir=$3

    echo -e "${YELLOW}▶ ${step_name}${NC}"

    if [ -n "$working_dir" ]; then
        cd "$working_dir"
    fi

    if eval "$command"; then
        echo -e "${GREEN}✅ ${step_name} - PASSED${NC}"
        echo ""
    else
        echo -e "${RED}❌ ${step_name} - FAILED${NC}"
        echo ""
        BUILD_SUCCESS=false
        return 1
    fi

    if [ -n "$working_dir" ]; then
        cd - > /dev/null
    fi
}

# Save original directory
ORIGINAL_DIR=$(pwd)

# Ensure we're in the cloud directory
if [ ! -f "package.json" ]; then
    echo -e "${RED}Error: Must run from cloud/ directory${NC}"
    exit 1
fi

echo "📍 Working directory: $(pwd)"
echo ""

# Clean previous builds (simulate fresh CI environment)
echo -e "${YELLOW}🧹 Cleaning previous builds...${NC}"
rm -rf packages/types/dist
rm -rf packages/sdk/dist
rm -rf packages/cloud/dist
echo -e "${GREEN}✅ Cleaned${NC}"
echo ""

# Step 1: Install dependencies (like CI does)
run_step "Install dependencies" "bun install" "" || exit 1

# Step 2: Build types package
run_step "Build @mentra/types" "bun run build" "packages/types" || exit 1

# Step 3: Build SDK package
run_step "Build @mentra/sdk" "bun run build" "packages/sdk" || exit 1

# Step 4: Build cloud package
run_step "Build @mentra/cloud" "bun run build" "packages/cloud" || exit 1

# Verification steps
echo ""
echo "🔍 Verification Checks"
echo "======================"
echo ""

# Check that dist folders exist
run_step "Verify @mentra/types dist/" "test -d packages/types/dist && test -f packages/types/dist/index.js" "" || BUILD_SUCCESS=false
run_step "Verify @mentra/sdk dist/" "test -d packages/sdk/dist && test -f packages/sdk/dist/index.js" "" || BUILD_SUCCESS=false
run_step "Verify @mentra/cloud dist/" "test -d packages/cloud/dist && test -f packages/cloud/dist/index.js" "" || BUILD_SUCCESS=false

# Check that @mentra/types was bundled (not referenced)
echo -e "${YELLOW}▶ Checking SDK doesn't reference @mentra/types externally${NC}"
if grep -q "@mentra/types" packages/sdk/dist/index.js 2>/dev/null; then
    echo -e "${RED}❌ SDK still has @mentra/types imports (should be bundled)${NC}"
    BUILD_SUCCESS=false
else
    echo -e "${GREEN}✅ SDK properly bundles @mentra/types${NC}"
fi
echo ""

# Check cloud can import from types
echo -e "${YELLOW}▶ Checking cloud can resolve @mentra/types${NC}"
if [ -f "packages/cloud/dist/index.js" ]; then
    echo -e "${GREEN}✅ Cloud build succeeded (can resolve types)${NC}"
else
    echo -e "${RED}❌ Cloud build failed (types not resolved)${NC}"
    BUILD_SUCCESS=false
fi
echo ""

# Final summary
cd "$ORIGINAL_DIR"
echo ""
echo "=============================="
if [ "$BUILD_SUCCESS" = true ]; then
    echo -e "${GREEN}✅ ALL CHECKS PASSED${NC}"
    echo ""
    echo "Your changes should work in CI! 🚀"
    echo "Safe to push."
    exit 0
else
    echo -e "${RED}❌ SOME CHECKS FAILED${NC}"
    echo ""
    echo "Fix the issues above before pushing."
    echo "CI will likely fail with the same errors."
    exit 1
fi
