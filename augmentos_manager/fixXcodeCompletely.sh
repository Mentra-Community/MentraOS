#!/bin/bash

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

echo "📦 Reinstalling pnpm dependencies..."
pnpm store prune
pnpm install

echo "🔧 Running Expo prebuild for iOS..."
pnpm exec expo prebuild --platform ios

echo "📦 Installing CocoaPods..."
cd ios
pod install
cd ..

echo "🚀 Reopening Xcode workspace..."
open ios/AOS.xcworkspace

echo "✅ All done. Clean rebuild ready."
