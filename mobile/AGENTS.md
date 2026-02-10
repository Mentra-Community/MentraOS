# MentraOS Manager Guidelines

RULES:
READ: mentraos-manager-guidelines.mdx

## Overview

MentraOS Manager is a React Native app built with Expo and expo-router for file-based routing. The app was recently migrated from vanilla React Native to Expo.

## Build and Test Commands

### Development

- Start dev server: `bun start` (expo start --dev-client)
- Run on Android: `bun android` (expo run:android)
- Run on iOS: `bun ios` (expo run:ios)
- Setup ADB port forwarding: `bun adb`

### Building

- Build Android release APK: `bun build:android:release`
- Build AAB for Google Play: `bun build:google:play` (generates signed AAB only)
- Upload to Google Play: `bun upload:google:play` (builds AAB and uploads to Play Store)
- Build iOS archive: `bun build:ios:archive`

### Testing

- Run tests: `bun test`
- Run tests in watch mode: `bun test:watch`
- Run single test: `bun test -- -t "test name"`
- Run Maestro E2E tests: `bun test:maestro`
- Lint code: `bun lint`
- Type check: `bun compile`

## Project Setup

### From Scratch (Android)

```bash
bun install
bun expo prebuild  # NEVER use --clean or --clear flags! We use custom native code
bun android
```

### From Scratch (iOS)

```bash
bun install
bun expo prebuild  # NEVER use --clean or --clear flags! We use custom native code
cd ios && pod install && cd ..
open ios/MentraOS.xcworkspace
# Install dev build on device using Xcode
bun start
```

### IMPORTANT: Never Use --clean or --clear with prebuild

**DO NOT** use `bun expo prebuild --clean` or `bun expo prebuild --clear` as these commands will delete custom native code modifications. This project makes heavy use of native Android and iOS code that must be preserved.

### Cache Issues Fix

If experiencing build issues after UI refresh:

```bash
bun install
bun expo prebuild  # NEVER use --clean or --clear flags!
rm -rf android/build android/.gradle node_modules .expo .bundle android/app/build android/app/src/main/assets
bun install
./scripts/old/fix-react-native-symlinks.sh
bun android
bun start
```

## Architecture Changes (Expo Migration)

### Key Changes

- **Routing**: File-based routing with expo-router (no more src/screens folder)
- **Imports**: Absolute paths instead of relative paths
- **Components**: Categorized into folders or misc/ folder
- **Theming**: Components use theme/themed from useAppTheme() hook
- **Entry Point**: expo-router/entry instead of traditional App.js

### File Structure

- `src/app/` - File-based routes (expo-router)
- `src/components/` - Reusable components (categorized by feature)
- `src/contexts/` - React Context providers
- `src/utils/` - Utility functions and helpers
- `src/theme/` - Theme configuration and styling

## Code Style

- TypeScript with React Native and Expo
- Imports: Absolute paths, group by external/internal, alphabetize within groups
- Formatting: Prettier with single quotes, no bracket spacing, trailing commas
- Components: Functional components with React hooks
- Naming: PascalCase for components, camelCase for functions/variables
- Navigation: File-based routing with expo-router (React Navigation under the hood)
- State management: Context API for app-wide state
- Error handling: Try/catch blocks with meaningful error messages

## Working with MentraOS

- Backend server required for local testing
- Port forwarding: `bun adb` (sets up tcp:9090, tcp:3000, tcp:9001, tcp:8081)
- Bluetooth functionality for glasses pairing

## Sentry Configuration (iOS)

Sentry source map and debug symbol uploads are **disabled by default** to prevent build failures when the `SENTRY_AUTH_TOKEN` is not configured.

### Enabling Sentry Uploads

To enable Sentry uploads for production builds:

1. Obtain your Sentry auth token from https://sentry.io/settings/account/api/auth-tokens/
2. Add the token to your environment:
   - **Option 1**: Add to `ios/.xcode.env.local` (recommended for local development):
     ```bash
     export SENTRY_AUTH_TOKEN=your_token_here
     export SENTRY_DISABLE_AUTO_UPLOAD=false
     ```
   - **Option 2**: Set as environment variable in your CI/CD pipeline:
     ```bash
     export SENTRY_AUTH_TOKEN=your_token_here
     export SENTRY_DISABLE_AUTO_UPLOAD=false
     ```

### Disabling Sentry Uploads

Sentry uploads are disabled by default. To explicitly disable them:

```bash
export SENTRY_DISABLE_AUTO_UPLOAD=true
```

This is already set in `ios/.xcode.env`, so builds will work without Sentry credentials.

## Development Environment Setup

### Recommended Platform

- **macOS or Linux** (recommended) - Windows has known issues with this project
- Use **nvm** (Node Version Manager) to manage Node.js versions
- **Node.js 20.x** (recommended version)

### Prerequisites

- Node.js ^18.18.0 || >=20.0.0 (20.x recommended)
- nvm (Node Version Manager - highly recommended)
- bun (preferred package manager)
- Android Studio (for Android development)
- Xcode (for iOS development on macOS)
- EAS CLI for building

### For nvm Users (Node.js version manager)

If you're using nvm and getting "command 'node' not found" errors during Android builds:

1. Run the fix script: `./scripts/old/fix-react-native-symlinks.sh`
2. This creates symlinks that prevent React Native libraries from executing node commands during build

This is needed because:

- Android Studio doesn't inherit shell PATH from nvm
- Some React Native libraries try to execute `node` commands during Gradle configuration
- The symlinks provide the React Native path directly, avoiding node command execution
