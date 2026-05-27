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

### AI agent attribution

Do not add `Co-Authored-By:` trailers that name AI assistants (Claude, Codex, Copilot, etc.) to commit messages. Do not include "Generated with" or similar attribution lines (e.g., `🤖 Generated with [Claude Code]`) in commit messages or PR descriptions. Commits and PRs should reflect the human author responsible for the change; the tools used to produce it are not part of the durable record.

## Environment & Security Notes

Cloud services require `.env` files copied from `.env.example` that stay local. Mobile secrets belong in `mobile/app.config.ts` or the secure config service—avoid committing device-specific tokens. Rebuild native projects after modifying BLE or camera modules to keep generated code in sync, and install Java 17, Android Studio, Xcode, Docker, and Bun/Node before the first build.

### Database Security

**CRITICAL**: When running MongoDB locally with Docker, always bind to localhost only:

```yaml
ports:
  - "127.0.0.1:27017:27017" # Correct - localhost only
  # NOT "27017:27017" which exposes to all interfaces
```

Automated ransomware scanners actively target exposed MongoDB instances. Use MongoDB Atlas for production deployments.

## Project Resources

- [GitHub Project Board - General Tasks](https://github.com/orgs/Mentra-Community/projects/2)
- [Discord Community](https://discord.gg/5ukNvkEAqT)

## Bug Report Logs

When working on bug reports linked to `console.mentra.glass/admin/incidents/{id}`:

1. Extract the incident ID from the URL
2. Fetch logs: `./scripts/fetch-incident-logs.sh {incidentId}`
3. Requires `MENTRA_AGENT_API_KEY` in your environment

The logs JSON contains:

- `phoneLogs` - Last 10 min of mobile app logs
- `cloudLogs` - Last 10 min of cloud service logs
- `glassesLogs` - Last 10 min of glasses logs (if available)
- `appTelemetryLogs` - Logs from third-party apps (if telemetry enabled)
- `phoneState` - Snapshot of app state at time of report
- `feedback` - User's bug report description

Example:

```bash
export MENTRA_AGENT_API_KEY=your-api-key
./scripts/fetch-incident-logs.sh 550e8400-e29b-41d4-a716-446655440000
```

## Additional Documentation

- Architecture specs and design docs: `/docs/`
- Module-specific implementation details: See module-specific `AGENTS.md` files

## Cursor Cloud specific instructions

### Docker limitation

Docker `docker compose up` does **not** work in Cloud Agent VMs due to cgroup v2 "threaded mode" conflicts in the nested container environment. Run the cloud backend directly instead:

```bash
cd cloud/packages/cloud && bun run dev
```

This uses `bun --watch` for hot reloading, matching the Docker dev behavior.

### Cloud backend direct run (non-Docker)

When running the cloud backend directly (without Docker), you need:

1. **Symlink `.env`**: `ln -sf /workspace/cloud/.env /workspace/cloud/packages/cloud/.env` -- `dotenv.config()` reads from cwd, and `bun run dev` runs from `packages/cloud/`.
2. **Set `PORT=8002`** in `cloud/.env` (the default `PORT=80` requires root).
3. **Add required secrets** to `cloud/.env` beyond `.env.example` defaults:
   - `AUGMENTOS_AUTH_JWT_SECRET` (any string for local dev)
   - `RESEND_API_KEY` (any placeholder)
   - `SUPABASE_SERVICE_KEY` (any placeholder; real key needed for auth flows)
4. MongoDB timeouts are expected without a real MongoDB instance -- the server still starts and serves HTTP/WebSocket traffic.

### Running services

| Service | Command | Port | Notes |
|---|---|---|---|
| Cloud backend | `cd cloud/packages/cloud && bun run dev` | 8002 | Requires `.env` symlink and secrets above |
| MentraOS Store | `cd cloud/websites/store && bun run dev` | 5173 | Pure frontend, works out of box |
| Developer Console | `cd cloud/websites/console && bun run dev` | 5174 | Pure frontend, works out of box |
| Account Portal | `cd cloud/websites/account && bun run dev` | 5175 | Pure frontend |

### Key commands reference

- **Build cloud packages**: `cd cloud && bun run build`
- **Lint cloud backend**: `cd cloud/packages/cloud && bun run lint` (pre-existing warnings/errors expected)
- **Lint store**: `cd cloud/websites/store && bun run lint`
- **Lint console**: `cd cloud/websites/console && bun run lint`
- **Run cloud tests**: `cd cloud && bun run test`
- **Copy env files**: Copy `.env.example` to `.env` in `cloud/`, `cloud/websites/store/`, `cloud/websites/console/`
