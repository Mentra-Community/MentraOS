# Mentra App Guidelines

This file is the module-local contributor and agent guidance for work under
`mobile/`.

## Overview

The Mentra App is a React Native app built with Expo and expo-router for file-based routing.

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

### Versioning

The repository-root `package.json#version` is the release family's canonical
future-production base version. `mobile/package.json#version` mirrors it and CI
derives `X.Y.Z-dev.N` or `X.Y.Z-beta.N` identities without source edits.

- Change the root and coordinated package mirrors together only when starting a
  new release train. `.env` and `.env.example` are not version authorities.
- Coordinated CI supplies one pinned numeric build number to both platforms.
  Local builds use `mobile/scripts/build-number.mjs`.
- Beta store builds are promotable production candidates and therefore target
  production services. They are distinguished by release metadata and their
  TestFlight/Play audience, not by a staging backend.
- Automatic glasses OTA is enabled only when the mobile bundle contains an
  `EXPO_PUBLIC_ASG_OTA_VERSION_URL` release pin. Local and compile-only builds
  without a pin fail closed; a Super Mode manifest override remains available
  for deliberate local OTA testing.

### Testing

- Run tests: `bun test`
- Run tests in watch mode: `bun test:watch`
- Run single test: `bun test -- -t "test name"`
- Run Maestro E2E tests: `bun test:maestro`
- Lint code: `bun lint`
- Type check: `bun compile`
- Bluetooth SDK Android compile check: `../scripts/check-android-compile.sh bluetooth-sdk`

`modules/bluetooth-sdk/android` contains the SDK Android sources, but local
Gradle checks should run through the generated `mobile/android` project via the
repo script above. The script installs mobile dependencies when needed, runs
`bun expo prebuild --platform android`, uses the generated Gradle wrapper, and
passes `-PmentraPublicSdk=true` for the SDK module check.

## Project Setup

### From Scratch (Android)

```bash
bun install
bun android
```

### From Scratch (iOS)

```bash
bun install
bun ios
```

### Expo prebuild safety

This project contains custom native code under `android/` and `ios/` that must
survive project generation. Never use `--clean` or `--clear` with
`expo prebuild`; those flags can delete the custom native projects.

```bash
# Correct: synchronize one generated project in place
bun expo prebuild --platform android
bun expo prebuild --platform ios

# Never run these in mobile/
bun expo prebuild --clean
bun expo prebuild --clear
```

This warning is specific to `expo prebuild`. A `--clear` flag on another tool,
such as Metro or `expo export`, has different semantics.

## Architecture and File Organization

### Key Changes

- **Routing**: File-based routing with expo-router (no more src/screens folder)
- **Imports**: Absolute paths instead of relative paths
- **Components**: Reusable components are grouped by feature
- **Theming**: New UI is Tailwind/Uniwind-first, with `useAppTheme()` for dynamic theme values
- **Entry Point**: expo-router/entry instead of traditional App.js
- **State**: React contexts provide app-wide services and Zustand stores hold app state

### File Structure

- `src/app/` - File-based routes; place screen components here
- `src/components/` - Reusable components organized by feature
- `src/contexts/` - React context providers and app-wide services
- `src/effects/` - App-level effects mounted by the navigation host
- `src/hooks/` - Reusable React hooks
- `src/i18n/` - English source strings, locale overrides, and translation helpers
- `src/services/` - Business logic and platform services
- `src/stores/` - Zustand state stores
- `src/utils/` - Utilities grouped into existing or clearly named feature folders
- `src/theme/` - Theme configuration and typed styling helpers

Prefer an existing feature directory. Create a new component or utility
directory only when no current category describes the responsibility.

## UI and Styling

- Prefer Tailwind/Uniwind `className` styles for new UI. Use semantic theme
  tokens such as `bg-primary-foreground` and `text-muted-foreground` rather
  than hard-coded colors.
- Use `useAppTheme()` from `@/contexts/ThemeContext` when a theme value must be
  passed through a React Native `style` object or a non-style prop such as an
  icon color. Do not import a runtime theme object to read the active palette.
- For theme-dependent styles that cannot be expressed with `className`, use
  `ThemedStyle` with the hook's `themed()` helper. Avoid adding a static
  `StyleSheet.create` block for theme-dependent values.
- Importing theme types or static primitives is acceptable; current colors and
  the selected light/dark variant must come from `useAppTheme()`.

## Navigation

Use the centralized navigation store for route mutations so app history,
animation, back prevention, and local-miniapp interception remain consistent:

```tsx
import {useNavigationStore} from "@/stores/navigation"

const {goBack, push, replace} = useNavigationStore.getState()
push("/settings/profile")
```

- Do not call expo-router's `router.push`, `router.replace`, or `router.back`
  directly from screens or ordinary components.
- Expo-router hooks such as `useLocalSearchParams` and `useFocusEffect` are
  appropriate for reading route state and reacting to focus.
- A direct router mutation is reserved for infrastructure that deliberately
  owns or bypasses the navigation store; document the reason at that boundary.

## Internationalization

- Do not hard-code user-facing copy when it belongs in the translation system.
- Add source keys to `src/i18n/en.ts`. Locale files inherit English and can
  override a key when a translation is available.
- Use the typed `tx` prop on Ignite components for declarative text:

  ```tsx
  <Text tx="settings:title" />
  <Button tx="common:ok" />
  ```

- Use `translate()` from `@/i18n` for imperative strings such as alert titles,
  messages, and native API arguments.

## Code Style and Type Safety

- TypeScript with React Native and Expo
- Imports: Group external, `@/` internal, and relative imports; alphabetize
  within groups
- Formatting: Use the checked-in Prettier configuration (double quotes, no
  semicolons, no bracket spacing, trailing commas)
- Components: Functional components with React hooks
- Naming: PascalCase for components, camelCase for functions/variables
- Type safety: `mobile/tsconfig.json` enables `strict` and `noImplicitAny`; do
  not add `any` when a concrete or shared domain type can describe the value
- Untyped boundaries: Validate or narrow external values as soon as they enter
  typed application code
- Error handling: Catch failures at I/O and user-action boundaries with
  meaningful context; use `Result`/`AsyncResult` from `typesafe-ts` in layers
  that model expected failures that way
- Performance: Use `memo`, `useMemo`, and `useCallback` for genuinely expensive
  work or identity-sensitive props, not mechanically on every component

## Working with MentraOS

- Backend server required for local testing
- Port forwarding: `bun adb` (sets up tcp:9090, tcp:3000, tcp:3003, tcp:9001, tcp:8081)
- Bluetooth functionality for glasses pairing
- **Background timers on Android are always native** (no env var, dev and
  release alike). If startup shows a "Background timers unavailable" alert or
  red-boxes in the nitro module, your dev client's native binary predates
  `react-native-nitro-bg-timer` — rebuild with `bun android`. Until then,
  backgrounded behavior is broken: engine timers freeze and local miniapps
  (captions, wake words) stop whenever the app isn't foregrounded.

## Mapbox tokens (two different credentials!)

- **Public token (`pk.…`)** — runtime map rendering. Lives in `.env` as
  `EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN`. Safe to ship in the app.
- **Downloads token (`sk.…`, secret scope `Downloads:Read`)** — build time only,
  authenticates downloading Mapbox's binary SDKs. Never shipped. It must live in:
  - `~/.netrc` for iOS (SPM reads it): `machine api.mapbox.com login mapbox password sk.…`
  - `MAPBOX_DOWNLOADS_TOKEN` env var for Android (Gradle maven repo auth)
  - GitHub Actions secret `MAPBOX_DOWNLOADS_TOKEN` for CI

Gotchas learned the hard way (2026-07):

- Most Mapbox package downloads are unauthenticated, but the **Navigation SDK
  binaries (`dash-native`) return 401 without a valid token from an account with
  an active (billing-enabled) subscription** — "an active subscription is
  required" means add a payment method + activate Navigation, not a token issue.
- Secret token values are shown **once** at creation. Store them in the company
  password manager, under a **shared org Mapbox account** — a departed
  employee's personal account once held our only working token.

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
