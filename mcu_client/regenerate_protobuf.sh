#!/bin/bash

# MentraOS BLE Protocol Buffer Regeneration Script
# This script regenerates protobuf files from mentraos_ble.proto and copies them to project locations

set -e  # Exit on any error

echo "🔄 Starting MentraOS BLE protobuf regeneration..."

# Check if protoc is available
if ! command -v protoc &> /dev/null; then
    echo "❌ Error: protoc not found. Please install Protocol Buffers compiler."
    exit 1
fi

echo "✅ Protoc found: $(protoc --version)"

# Create temporary directory for generation
TEMP_DIR=$(mktemp -d)
echo "📁 Using temporary directory: $TEMP_DIR"

# Change to script directory
cd "$(dirname "$0")"

# Generate protobuf files
echo "🔨 Generating protobuf files..."
protoc --java_out="$TEMP_DIR" \
       --swift_out="$TEMP_DIR" \
       --cpp_out="$TEMP_DIR" \
       --python_out="$TEMP_DIR" \
       mentraos_ble.proto

echo "✅ Protobuf files generated successfully"

# Copy Java file to Android project
echo "📱 Copying Java file to Android project..."
if [ -f "$TEMP_DIR/mentraos/ble/MentraosBle.java" ]; then
    cp "$TEMP_DIR/mentraos/ble/MentraosBle.java" "../android_core/app/src/main/java/mentraos/ble/"
    echo "✅ Java file copied to android_core"
else
    echo "❌ Java file not found in generated output"
fi

# Copy Swift file to iOS project
echo "🍎 Copying Swift file to iOS project..."
if [ -f "$TEMP_DIR/mentraos_ble.pb.swift" ]; then
    cp "$TEMP_DIR/mentraos_ble.pb.swift" "../mobile/ios/Source/subs/"
    echo "✅ Swift file copied to iOS project"
else
    echo "❌ Swift file not found in generated output"
fi

# Copy C++ files to appropriate location if needed
echo "⚙️ C++ files generated:"
if [ -f "$TEMP_DIR/mentraos_ble.pb.h" ]; then
    echo "  - Header: $TEMP_DIR/mentraos_ble.pb.h"
fi
if [ -f "$TEMP_DIR/mentraos_ble.pb.cc" ]; then
    echo "  - Source: $TEMP_DIR/mentraos_ble.pb.cc"
fi

# Clean up temporary directory
echo "🧹 Cleaning up temporary files..."
rm -rf "$TEMP_DIR"

echo "🎉 Protobuf regeneration completed successfully!"
echo ""
echo "Generated files:"
echo "  - Java: ../android_core/app/src/main/java/mentraos/ble/MentraosBle.java"
echo "  - Swift: ../mobile/ios/Source/subs/mentraos_ble.pb.swift"
echo "  - C++: Header and source files (see above)"
echo "  - Python: mentraos_ble_pb2.py"
echo ""
echo "⚠️  Note: You may need to rebuild your projects after regeneration."
