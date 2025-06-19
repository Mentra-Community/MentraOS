#!/bin/bash
# Fix React Native library symlinks for nvm users
# This script creates symlinks to avoid node command execution during Android builds
# Automatically runs after npm install via postinstall script

# Exit on any error
set -e

# Only run on Unix-like systems
if [[ "$OSTYPE" != "linux-gnu"* && "$OSTYPE" != "darwin"* ]]; then
  echo "ℹ️  Skipping React Native symlink fix on $OSTYPE"
  exit 0
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "ℹ️  No node_modules directory found, skipping symlink creation"
  exit 0
fi

echo "🔧 Creating React Native symlinks to avoid node command execution..."

cd "$(dirname "$0")"

# Counter for created symlinks
count=0

# Create symlinks for all react-native-* libraries
find node_modules -name "react-native-*" -type d -maxdepth 1 | while read dir; do
  if [ ! -d "$dir/node_modules" ]; then
    mkdir -p "$dir/node_modules"
  fi
  if [ ! -L "$dir/node_modules/react-native" ]; then
    cd "$dir/node_modules"
    ln -sf ../../react-native react-native
    cd - >/dev/null
    echo "  ✅ Created symlink for $dir"
    ((count++))
  fi
done

if [ $count -eq 0 ]; then
  echo "ℹ️  All React Native symlinks already exist"
else
  echo "🎉 Created $count React Native symlinks successfully!"
fi

echo "💡 This fixes the 'command node not found' error for nvm users during Android builds."