#!/bin/bash
# Build script for LC3 converter
# Detects platform and builds the LC3 shared library

set -e

echo "🔧 Building LC3 Converter..."
echo

# Check for required tools
if ! command -v gcc &> /dev/null && ! command -v clang &> /dev/null; then
    echo "❌ Error: No C compiler found (gcc or clang required)"
    exit 1
fi

# Detect platform
if [[ "$OSTYPE" == "darwin"* ]]; then
    PLATFORM="macOS"
    LIB_EXT="dylib"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    PLATFORM="Linux"
    LIB_EXT="so"
else
    echo "⚠️  Warning: Unknown platform $OSTYPE, assuming Linux"
    PLATFORM="Linux"
    LIB_EXT="so"
fi

echo "Platform: $PLATFORM"
echo

# Build the library
echo "Building LC3 shared library..."
make clean
make

# Verify build
if [ -f "lib/liblc3.$LIB_EXT" ]; then
    echo
    echo "✅ Build successful!"
    echo "Library: lib/liblc3.$LIB_EXT"
    echo
    echo "Next steps:"
    echo "  1. Test with: python audio_to_lc3.py test_audio/sample.wav output.lc3"
    echo "  2. For MP3 support: pip install -r requirements.txt"
else
    echo
    echo "❌ Build failed - library not found"
    exit 1
fi

