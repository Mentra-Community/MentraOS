#!/bin/bash

set -e

echo "🛑 Killing Xcode and stuck PIF processes..."
pkill -9 -f Xcode || true
pkill -9 -f pif || true

echo "🛡️ Clearing special flags on node_modules (macOS fix)..."
chflags -R nouchg node_modules || true

echo "🧹 Fixing node_modules permissions if needed..."
chmod -R 777 node_modules || true

echo "🧹 Deleting DerivedData, node_modules, and Pods..."
rm -rf ~/Library/Developer/Xcode/DerivedData/*
rm -rf node_modules ios/build ios/Pods ios/Podfile.lock

echo "📦 Reinstalling npm dependencies..."
npm cache clean --force
npm install
# Make sure react-devtools-core is installed properly
npm install --save-dev react-devtools-core

echo "📦 Reinstalling CocoaPods..."
cd ios
pod install
cd ..

echo "🚀 Reopening Xcode workspace..."
open ios/AugmentOS_Manager.xcworkspace

echo "✅ All done. Clean rebuild ready."
<<<<<<< HEAD

=======
>>>>>>> origin/dev
