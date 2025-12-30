#!/bin/bash

# Test Docker build locally to match Porter deployment
# This helps debug build issues before deploying to Porter

set -e

echo "🐳 Testing Captions Docker build locally..."
echo ""

# Get the git commit hash (like Porter does)
GIT_SHA=$(git rev-parse --short HEAD)
IMAGE_NAME="mentra-captions-test"
IMAGE_TAG="${IMAGE_NAME}:${GIT_SHA}"

echo "📦 Building Docker image..."
echo "   Image: ${IMAGE_TAG}"
echo "   Context: ./cloud/."
echo "   Dockerfile: ./cloud/docker/Dockerfile.captions"
echo ""

# Build from the project root (like Porter does)
cd "$(git rev-parse --show-toplevel)"

docker build \
  -f cloud/docker/Dockerfile.captions \
  -t "${IMAGE_TAG}" \
  cloud/.

echo ""
echo "✅ Build successful!"
echo ""
echo "🧪 Running diagnostic tests..."
echo ""

# Test 1: Check if the files are in the right place
echo "Test 1: Checking webview/lib file structure..."
docker run --rm "${IMAGE_TAG}" sh -c "ls -la /app/packages/apps/captions/src/webview/lib/ 2>/dev/null || echo '❌ lib directory missing'"

echo ""
echo "Test 2: Checking if languages.ts exists..."
if docker run --rm "${IMAGE_TAG}" test -f /app/packages/apps/captions/src/webview/lib/languages.ts 2>/dev/null; then
  echo "✅ languages.ts found"
  docker run --rm "${IMAGE_TAG}" sh -c "wc -l /app/packages/apps/captions/src/webview/lib/languages.ts"
else
  echo "❌ languages.ts missing"
fi

echo ""
echo "Test 3: Checking if colors.ts exists..."
if docker run --rm "${IMAGE_TAG}" test -f /app/packages/apps/captions/src/webview/lib/colors.ts 2>/dev/null; then
  echo "✅ colors.ts found"
  docker run --rm "${IMAGE_TAG}" sh -c "wc -l /app/packages/apps/captions/src/webview/lib/colors.ts"
else
  echo "❌ colors.ts missing"
fi

echo ""
echo "Test 4: Checking tsconfig.json configuration..."
docker run --rm "${IMAGE_TAG}" sh -c "cat /app/packages/apps/captions/tsconfig.json | grep -A 7 'paths'"

echo ""
echo "Test 5: Verifying Bun version..."
docker run --rm "${IMAGE_TAG}" bun --version

echo ""
echo "Test 6: Testing if Bun can resolve @/ imports (Header.tsx)..."
if docker run --rm "${IMAGE_TAG}" sh -c "cd /app/packages/apps/captions && bun build src/webview/components/Header.tsx --outdir /tmp/test --target browser" 2>&1 | grep -q "Bundled"; then
  echo "✅ Header.tsx build test passed"
else
  echo "❌ Header.tsx build test failed"
  docker run --rm "${IMAGE_TAG}" sh -c "cd /app/packages/apps/captions && bun build src/webview/components/Header.tsx --outdir /tmp/test --target browser" 2>&1
fi

echo ""
echo "Test 7: Testing if Bun can resolve @/ imports (TranscriptItem.tsx)..."
if docker run --rm "${IMAGE_TAG}" sh -c "cd /app/packages/apps/captions && bun build src/webview/components/TranscriptItem.tsx --outdir /tmp/test --target browser" 2>&1 | grep -q "Bundled"; then
  echo "✅ TranscriptItem.tsx build test passed"
else
  echo "❌ TranscriptItem.tsx build test failed"
  docker run --rm "${IMAGE_TAG}" sh -c "cd /app/packages/apps/captions && bun build src/webview/components/TranscriptItem.tsx --outdir /tmp/test --target browser" 2>&1
fi

echo ""
echo "Test 8: Testing full app build..."
if docker run --rm "${IMAGE_TAG}" sh -c "cd /app/packages/apps/captions && bun build src/webview/frontend.tsx --outdir /tmp/test --target browser" 2>&1 | grep -q "Bundled"; then
  echo "✅ Frontend build test passed"
else
  echo "❌ Frontend build test failed - showing error:"
  docker run --rm "${IMAGE_TAG}" sh -c "cd /app/packages/apps/captions && bun build src/webview/frontend.tsx --outdir /tmp/test --target browser" 2>&1
fi

echo ""
echo "=========================================="
echo "All diagnostic tests complete!"
echo "=========================================="
echo ""
echo "🚀 Starting the container (press Ctrl+C to stop)..."
echo "   Access at: http://localhost:8080"
echo ""
echo "Note: You need to provide MENTRAOS_API_KEY for the app to start:"
echo "   export MENTRAOS_API_KEY=your-key-here"
echo ""

# Run with environment variables
docker run --rm -it \
  -p 8080:80 \
  -e NODE_ENV=development \
  -e PORT=80 \
  -e HOST=0.0.0.0 \
  -e MENTRAOS_API_KEY=${MENTRAOS_API_KEY:-""} \
  -e PACKAGE_NAME=com.mentra.captions \
  "${IMAGE_TAG}"

echo ""
echo "🧹 Cleanup: Run 'docker rmi ${IMAGE_TAG}' to remove the test image"
