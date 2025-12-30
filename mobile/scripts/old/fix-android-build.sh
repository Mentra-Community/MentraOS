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

# Fix Android build issues script
# This script cleans all caches and rebuilds the Android project

echo "🔧 Fixing Android build issues..."
echo ""

# Step 1: Clean all build artifacts, caches, and lock files
echo "📦 Step 1: Cleaning build artifacts, caches, and lock files..."
rm -rf android/build android/.gradle node_modules .expo .bundle android/app/build android/app/src/main/assets

# Clean lock files (critical for fixing dependency conflicts)
echo "🗑️  Removing lock files..."
rm -f bun.lock pnpm-lock.yaml package-lock.json yarn.lock

# Clean nested node_modules in modules (critical for fixing duplicate dependencies)
echo "🗑️  Removing nested node_modules in modules/..."
find modules -type d -name "node_modules" -exec rm -rf {} + 2>/dev/null || true

# Step 2: Install dependencies with clean slate
echo ""
echo "📦 Step 2: Installing dependencies (clean install)..."
bun install

# Step 3: Verify dependencies are healthy
echo ""
echo "🔍 Step 3: Checking for dependency issues..."
if command -v npx &> /dev/null; then
    # Use --yes to auto-accept npx install prompts, run without piping to show full output
    npx --yes expo-doctor || true
    echo ""
fi

# Step 4: Prebuild with Expo
echo ""
echo "🏗️  Step 4: Running Expo prebuild..."
bun expo prebuild

# Step 5: Fix React Native symlinks
echo ""
echo "🔗 Step 5: Fixing React Native symlinks..."
if [ -f "./scripts/fix-react-native-symlinks.sh" ]; then
    ./scripts/fix-react-native-symlinks.sh
else
    echo "⚠️  Warning: fix-react-native-symlinks.sh not found"
    echo "Creating symlinks manually..."
    
    # Create symlinks for common problematic modules
    MODULES=(
        "react-native-gesture-handler"
        "react-native-reanimated"
        "react-native-screens"
        "react-native-safe-area-context"
        "react-native-svg"
    )
    
    for MODULE in "${MODULES[@]}"; do
        MODULE_PATH="node_modules/$MODULE"
        if [ -d "$MODULE_PATH" ]; then
            # Remove existing nested node_modules if it exists
            if [ -d "$MODULE_PATH/node_modules" ]; then
                rm -rf "$MODULE_PATH/node_modules"
            fi
            
            # Create node_modules directory
            mkdir -p "$MODULE_PATH/node_modules"
            
            # Create symlink to react-native
            ln -sf "../../react-native" "$MODULE_PATH/node_modules/react-native"
            echo "✅ Created symlink for $MODULE"
        fi
    done
fi

# Step 6: Clean Gradle cache
echo ""
echo "🧹 Step 6: Cleaning Gradle cache..."
cd android && ./gradlew clean && cd ..

# Step 7: Final dependency check
echo ""
echo "✅ Step 7: Final dependency verification..."
if command -v npx &> /dev/null; then
    # Use --yes to auto-accept npx install prompts
    npx --yes expo-doctor || echo "⚠️  Warning: There may still be dependency issues. Check output above."
fi

# Step 8: Build Android
echo ""
echo "🚀 Step 8: Building Android app..."
bun android

# Check if build was successful
if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Android build completed successfully!"
    echo ""
    echo "📱 Your app should now be running!"
    echo ""
    echo "If you encounter issues:"
    echo "  • Check that dependencies are clean: npx expo-doctor"
    echo "  • Restart Metro bundler: bun start --clear"
    echo "  • Force stop the app and relaunch"
else
    echo ""
    echo "❌ Android build failed!"
    echo ""
    echo "Troubleshooting steps:"
    echo "1. Check for dependency conflicts: npx expo-doctor"
    echo "2. Manually run: bun expo prebuild"
    echo "3. Try: cd android && ./gradlew clean && cd .."
    echo "4. Then: bun android"
    echo ""
    echo "If MMKV or native modules fail to load:"
    echo "  • Completely uninstall the app from your device/emulator"
    echo "  • Run this script again"
fi