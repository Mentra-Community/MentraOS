#!/bin/bash

# Quick test to verify import resolution works locally
# Run this before pushing to ensure Docker build will work

set -e

echo "🧪 Testing import resolution for Captions app..."
echo ""

cd "$(dirname "$0")"

echo "📍 Current directory: $(pwd)"
echo ""

# Test 1: Check files exist
echo "Test 1: Checking if source files exist..."
if [ -f "src/webview/lib/languages.ts" ]; then
  echo "  ✅ languages.ts exists ($(wc -l < src/webview/lib/languages.ts) lines)"
else
  echo "  ❌ languages.ts missing!"
  exit 1
fi

if [ -f "src/webview/lib/colors.ts" ]; then
  echo "  ✅ colors.ts exists ($(wc -l < src/webview/lib/colors.ts) lines)"
else
  echo "  ❌ colors.ts missing!"
  exit 1
fi

echo ""

# Test 2: Check tsconfig
echo "Test 2: Checking tsconfig.json configuration..."
if grep -q '"baseUrl"' tsconfig.json; then
  echo "  ✅ baseUrl is set"
else
  echo "  ⚠️  baseUrl not found in tsconfig.json"
fi

if grep -q '"@/\*"' tsconfig.json; then
  echo "  ✅ @/* path alias configured"
else
  echo "  ❌ @/* path alias not found!"
  exit 1
fi

echo ""

# Test 3: Build Header component
echo "Test 3: Building Header.tsx (tests @/lib/languages import)..."
if bun build src/webview/components/Header.tsx --outdir /tmp/test-captions --target browser > /dev/null 2>&1; then
  echo "  ✅ Header.tsx builds successfully"
else
  echo "  ❌ Header.tsx build failed!"
  echo ""
  echo "Error details:"
  bun build src/webview/components/Header.tsx --outdir /tmp/test-captions --target browser
  exit 1
fi

echo ""

# Test 4: Build TranscriptItem component
echo "Test 4: Building TranscriptItem.tsx (tests @/lib/colors import)..."
if bun build src/webview/components/TranscriptItem.tsx --outdir /tmp/test-captions --target browser > /dev/null 2>&1; then
  echo "  ✅ TranscriptItem.tsx builds successfully"
else
  echo "  ❌ TranscriptItem.tsx build failed!"
  echo ""
  echo "Error details:"
  bun build src/webview/components/TranscriptItem.tsx --outdir /tmp/test-captions --target browser
  exit 1
fi

echo ""

# Test 5: Build LanguageModal component
echo "Test 5: Building LanguageModal.tsx (tests @/lib/languages import)..."
if bun build src/webview/components/LanguageModal.tsx --outdir /tmp/test-captions --target browser > /dev/null 2>&1; then
  echo "  ✅ LanguageModal.tsx builds successfully"
else
  echo "  ❌ LanguageModal.tsx build failed!"
  echo ""
  echo "Error details:"
  bun build src/webview/components/LanguageModal.tsx --outdir /tmp/test-captions --target browser
  exit 1
fi

echo ""

# Test 6: Build entire frontend
echo "Test 6: Building complete frontend.tsx..."
if bun build src/webview/frontend.tsx --outdir /tmp/test-captions --target browser > /dev/null 2>&1; then
  echo "  ✅ Frontend builds successfully"

  # Show bundle size
  if [ -f "/tmp/test-captions/frontend.js" ]; then
    SIZE=$(du -h /tmp/test-captions/frontend.js | cut -f1)
    echo "  📦 Bundle size: $SIZE"
  fi
else
  echo "  ❌ Frontend build failed!"
  echo ""
  echo "Error details:"
  bun build src/webview/frontend.tsx --outdir /tmp/test-captions --target browser
  exit 1
fi

echo ""
echo "=========================================="
echo "✅ All import resolution tests passed!"
echo "=========================================="
echo ""
echo "The code should work in Docker/Porter deployment."
echo ""
echo "Next steps:"
echo "  1. Run './test-docker.sh' to test the full Docker build"
echo "  2. Push your changes to trigger Porter deployment"
echo ""

# Cleanup
rm -rf /tmp/test-captions

exit 0
