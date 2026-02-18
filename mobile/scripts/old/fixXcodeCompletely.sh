#!/bin/bash

# Check if we're in a "scripts" directory
current_dir=$(basename "$PWD")
if [ "$current_dir" = "scripts" ]; then
    echo "In scripts directory, moving to parent..."
    cd ..
    echo "Now in: $PWD"
else
    echo "Not in a scripts directory. Current directory: $current_dir"
fi

set -e

echo "🛑 Killing Xcode and stuck PIF processes..."
pkill -9 -f Xcode || true
pkill -9 -f pif || true

echo "🛡️ Clearing special flags on node_modules (macOS fix)..."
chflags -R nouchg node_modules || true

echo "🧹 Fixing node_modules permissions if needed..."
chmod -R 777 node_modules || true

echo "🧹 Deleting DerivedData, node_modules, and iOS build files..."
rm -rf ~/Library/Developer/Xcode/DerivedData/*
rm -rf node_modules ios/build ios/Pods ios/Podfile.lock

echo "📦 Reinstalling dependencies..."
rm -rf node_modules
#pnpm install
bun install

echo "🔧 Running Expo prebuild for iOS..."
bun expo prebuild --platform ios

echo "📦 Installing CocoaPods..."
cd ios
pod install
cd ..

echo "🚀 Reopening Xcode workspace..."
open ios/MentraOS.xcworkspace

echo "✅ All done. Clean rebuild ready."
