# AGENTS.md

Repository implementation guidelines for coding agents working with MentraOS.

## Project Overview

MentraOS is an open source operating system, app store, and development framework for smart glasses.

- Architecture: Smart glasses connect to user's phone via BLE; phone connects to backend; backend connects to third-party app servers running the MentraOS SDK
- Mobile app: `mobile` (React Native with native modules)
- Android logic: `android_core`
- iOS native module: `mobile/ios`
- Backend & web portals: `cloud` (includes developer portal & app store)
- Android-based smart glasses client: `asg_client` (uses `android_core` as a library)
- MentraOS Store: `cloud/store/` (web app for app discovery)
- Developer Console: `cloud/websites/console/` (web app for app management)

## Monorepo Structure

This is a monorepo with module-specific guidance:

- `/mobile/AGENTS.md` - React Native mobile app guidelines
- `/cloud/AGENTS.md` - Backend services guidelines
- `/cloud/websites/console/AGENTS.md` - Developer portal guidelines
- `/cloud/websites/store/AGENTS.md` - Store frontend guidelines

Consult module-specific AGENTS.md when working within that module.

## Project Structure & Module Organization

Core client app lives in `mobile/` (Expo React Native). Backend services, the TypeScript SDK, and the store front end sit in `cloud/packages/`, with integration tests in `cloud/tests/`. Platform SDKs are in `android_core/`, `android_library/`, `sdk_ios/`; hardware tooling lives in `mcu_client/`. Notes and plans live in `agents/` and `docs/`.

## Build Commands

### React Native (mobile)

- Start dev server: `npm start` or `bun start`
- Run on platforms: `npm run android`, `npm run ios` or `bun android`, `bun ios`
- Build Android: `npm run build-android`, `npm run build-android-release`
- Run tests: `npm test`, `npm test -- -t "test name"` (single test)
- Lint code: `npm run lint` or `bun lint`
- iOS setup: `cd ios && pod install && cd ..`
- Prebuild: `bun expo prebuild` (syncs native projects - NEVER use --clean or --clear flags!)

### Cloud Backend (cloud)

- Install deps: `bun install`
- Setup environment: `./scripts/docker-setup.sh` or `bun run setup-deps && bun run dev`
- Dev: `bun run dev` (starts Docker dev environment)
- Setup Docker network: `bun run dev:setup-network` (run once)
- Build: `bun run build` (builds sdk, utils, and agents packages)
- Test: `bun run test` (runs backend test suites)
- Lint: `cd packages/cloud && bun run lint`

## Prerequisites

### Recommended Platform

- **macOS or Linux** (recommended for mobile development) - Windows has known issues with this project
- Use **nvm** (Node Version Manager) to manage Node.js versions
- **Node.js 20.x** (recommended version)

### Required Software

- Node.js ^18.18.0 || >=20.0.0 (20.x recommended)
- nvm (Node Version Manager - highly recommended)
- npm/yarn/bun (bun preferred)
- Android Studio (for Android development)
- Xcode (for iOS development on macOS)
- Docker and Docker Compose (for cloud development)
- Java SDK 17 (for Android components)

## Code Style Guidelines

### Java/Android

- Java SDK 17 required
- Classes: PascalCase
- Methods: camelCase
- Constants: UPPER_SNAKE_CASE
- Member variables: mCamelCase (with m prefix)
- Javadoc for public methods and classes
- 2-space indentation
- EventBus for component communication

### TypeScript/React Native

- Functional components with React hooks
- Imports: Group by external/internal, alphabetize within groups
- Formatting: Prettier with single quotes, no bracket spacing, trailing commas (2-space indent)
- Navigation: React Navigation with typed params (expo-router for mobile)
- Context API for app-wide state
- Feature-based organization under src/
- Use try/catch with meaningful error messages
- Strict typing with interfaces for message types
- PascalCase for components/classes/interfaces/types, camelCase for variables/functions/hooks
- UPPER_SNAKE_CASE for environment keys

### Swift

- Use `swiftformat` for formatting

## Naming Conventions

- User-facing names: CamelCase ("MentraOS App", "MentraOS Store", "MentraOS Manager")
- Code follows language-specific conventions (Java, TypeScript, Swift)

## Testing Guidelines

Cloud services use Jest via `bun run test`; add suites in `cloud/tests/` mirroring package names and mock external providers. Mobile UI logic uses Jest (`bun test`, `bun test:watch`) with files colocated in `mobile/test/` and snapshots beside components. Device flows rely on Maestro (`bun test:maestro`), so update scripts whenever navigation or pairing shifts. Features touching pairing, BLE, or transcription need unit coverage plus an end-to-end path.

## Commit & Pull Request Guidelines

Write imperative, present-tense commit subjects (e.g., "Add BLE retry delay") and keep scope focused. Reference issue IDs or Slack threads in the body when applicable. Before opening a PR, run relevant `bun run test` suites and platform builds, attach log excerpts for hardware-dependent steps, and call out configuration updates. PR descriptions should outline scope, test evidence, and screenshots or screen recordings for UI-impacting changes.

## Environment & Security Notes

Cloud services require `.env` files copied from `.env.example` that stay local. Mobile secrets belong in `mobile/app.config.ts` or the secure config service—avoid committing device-specific tokens. Rebuild native projects after modifying BLE or camera modules to keep generated code in sync, and install Java 17, Android Studio, Xcode, Docker, and Bun/Node before the first build.

### Database Security

**CRITICAL**: When running MongoDB locally with Docker, always bind to localhost only:

```yaml
ports:
  - "127.0.0.1:27017:27017"  # Correct - localhost only
  # NOT "27017:27017" which exposes to all interfaces
```

Automated ransomware scanners actively target exposed MongoDB instances. Use MongoDB Atlas for production deployments.

## Project Resources

- [GitHub Project Board - General Tasks](https://github.com/orgs/Mentra-Community/projects/2)
- [Discord Community](https://discord.gg/5ukNvkEAqT)

## Additional Documentation

- Architecture specs and design docs: `/docs/`
- Module-specific implementation details: See module-specific `AGENTS.md` files
