# AugmentOS Manager Guidelines

## Overview
AugmentOS Manager is a React Native app built with Expo and expo-router for file-based routing. The app was recently migrated from vanilla React Native to Expo.

## Build and Test Commands

### Development
- Start dev server: `pnpm start` (expo start --dev-client)
- Run on Android: `pnpm android` (expo run:android)
- Run on iOS: `pnpm ios` (expo run:ios)
- Setup ADB port forwarding: `pnpm adb`

### Building
- Build Android release APK: `pnpm build:android:release`
- Build AAB for Google Play: `pnpm build:google:play` (generates signed AAB only)
- Upload to Google Play: `pnpm upload:google:play` (builds AAB and uploads to Play Store)
- Build iOS simulator: `pnpm build:ios:sim`
- Build iOS device (dev): `pnpm build:ios:dev`
- Build iOS preview: `pnpm build:ios:preview`
- Build iOS production: `pnpm build:ios:prod`

### Testing
- Run tests: `pnpm test`
- Run tests in watch mode: `pnpm test:watch`
- Run single test: `pnpm test -- -t "test name"`
- Run Maestro E2E tests: `pnpm test:maestro`
- Lint code: `pnpm lint`
- Type check: `pnpm compile`

## Project Setup

### From Scratch (Android)
```bash
pnpm install
pnpm expo prebuild
pnpm android
```

### From Scratch (iOS)
```bash
pnpm install
pnpm expo prebuild
cd ios && pod install && cd ..
open ios/AOS.xcworkspace
# Install dev build on device using Xcode
pnpm start
```

### Cache Issues Fix
If experiencing build issues after UI refresh:
```bash
pnpm install
pnpm expo prebuild
rm -rf android/build android/.gradle node_modules .expo .bundle android/app/build android/app/src/main/assets
pnpm install
./fix-react-native-symlinks.sh 
pnpm android
pnpm start
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

## Working with AugmentOS
- Backend server required for local testing
- Port forwarding: `pnpm adb` (sets up tcp:9090, tcp:3000, tcp:9001, tcp:8081)
- Bluetooth functionality for glasses pairing

## Development Environment Setup

### Prerequisites
- Node.js ^18.18.0 || >=20.0.0
- pnpm (preferred package manager)
- Android Studio (for Android development)
- Xcode (for iOS development)
- EAS CLI for building

### For nvm Users (Node.js version manager)
If you're using nvm and getting "command 'node' not found" errors during Android builds:

1. Run the fix script: `./fix-react-native-symlinks.sh`
2. This creates symlinks that prevent React Native libraries from executing node commands during build

This is needed because:
- Android Studio doesn't inherit shell PATH from nvm
- Some React Native libraries try to execute `node` commands during Gradle configuration
- The symlinks provide the React Native path directly, avoiding node command execution