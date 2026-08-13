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
- MentraOS Store: `cloud/websites/store/` (web app for app discovery)
- Developer Console: `cloud/websites/console/` (web app for app management)

## Monorepo Structure

This is a monorepo with module-specific guidance:

- `/mobile/AGENTS.md` - React Native mobile app guidelines
- `/cloud/AGENTS.md` - Backend services guidelines
- `/cloud/websites/console/AGENTS.md` - Developer portal guidelines
- `/cloud/websites/store/AGENTS.md` - Store frontend guidelines

Consult module-specific AGENTS.md when working within that module.

## Project Structure & Module Organization

Core client app lives in `mobile/` (Expo React Native). Backend services and the TypeScript SDK sit in `cloud/packages/`, while the Developer Console and Store front ends live in `cloud/websites/`; cloud integration tests are in `cloud/tests/`. Platform SDKs are in `android_core/`, `android_library/`, `sdk_ios/`; hardware tooling lives in `mcu_client/`. Public Mintlify docs live in `mintlify-docs/`; notes and plans live in `agents/` and `notes/` — see [`notes/README.md`](notes/README.md) for the specs/plans convention.

## Build Commands

### React Native (mobile)

- Start dev server: `npm start` or `bun start`
- Run on platforms: `npm run android`, `npm run ios` or `bun android`, `bun ios`
- Build Android: `npm run build-android`, `npm run build-android-release`
- Run tests: `npm test`, `npm test -- -t "test name"` (single test)
- Lint code: `npm run lint` or `bun lint`
- iOS setup: `cd ios && pod install && cd ..`
- Prebuild: `bun expo prebuild` (syncs native projects - NEVER use --clean or --clear flags!)

### Local Android compile checks

- ASG client compile check: `./scripts/check-android-compile.sh asg`
- Bluetooth SDK Android compile check: `./scripts/check-android-compile.sh bluetooth-sdk`
- Both checks: `./scripts/check-android-compile.sh`

The Bluetooth SDK Android sources under `mobile/modules/bluetooth-sdk/android`
are compiled through the generated Expo Android project at `mobile/android`,
matching CI. Do not rely on a system `gradle` install from the SDK source
directory; use the repo script so the Gradle wrapper and prebuild setup are
consistent. The Bluetooth SDK check runs with `-PmentraPublicSdk=true` so it
validates the public Maven artifact dependency shape.

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

- Code follows language-specific conventions (Java, TypeScript, Swift)

### Product & terminology (user-facing copy, docs, marketing)

- **`miniapp`** is always one word, lowercase, in running text.
- **Products take a capital `M`**: "Mentra Miniapp SDK", "Mentra Miniapp Store".
  When you write "miniapp SDK" capitalize it as "**Miniapp SDK**"; the full
  product name is "**Mentra Miniapp SDK**" (not "MentraOS miniapp SDK").
- The **iOS/Android mobile app** is the "**Mentra App**" (not "MentraOS app",
  not "Mentra app").
- **Miniapps in general** (apps that run on the Mentra platform) are "**Mentra
  miniapp**" / "**Mentra miniapps**" (not "MentraOS apps").
- The store is the "**Mentra Miniapp Store**".
- "**MentraOS**" stays as-is when it names the operating system / platform /
  repo (e.g. "MentraOS is the operating system for smart glasses"). Don't swap
  it for "Mentra" in those cases.
- The package identifier `@mentra/miniapp` is code; leave it in code formatting.

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

### Related Miniapp Repositories

- [Mentra Notes Miniapp](https://github.com/Mentra-Community/Mentra-Notes-Miniapp)
- [Livestreamer Miniapp](https://github.com/Mentra-Community/Livestreamer-Miniapp)
- [Mentra AI Miniapp](https://github.com/Mentra-Community/Mentra-AI-Miniapp)
- [Mentra Enterprise Miniapp](https://github.com/Mentra-Community/Mentra-Enterprise-Miniapp)

If a MentraOS PR also requires changes to one of the external miniapps above, or
you are otherwise asked to change one of those miniapps:

1. Clone the external miniapp repository if needed, or pull the latest `main`
   branch if it is already available locally.
2. Make the changes in the external miniapp repository, bump its version, and
   push the changes directly to that repository's `main` branch.
3. Package the updated miniapp as a ZIP archive.
4. Add the new ZIP archive to `mobile/assets/miniapps/` in the MentraOS
   monorepo so the external miniapp update is included in the MentraOS mobile
   PR.

## Bug Report Logs

Bug reports and feedback filed from the Mentra App land in the Cloud V2 reports system. Report ids look like `rep_01...` and appear in the reports Slack notifications and in the admin console's Incident system page (admin.mentraglass.com).

1. Get the report id (from Slack, the admin console, or the user)
2. Fetch it: `./scripts/fetch-incident-logs.sh {reportId}` — downloads `report.json` plus every artifact into `./incident-logs/{reportId}/`
3. Requires `MENTRA_ADMIN_TOKEN` in your environment: an org API key (`msk_...`) whose synthetic email is allowlisted via `CLOUD_CORE_ADMIN_EMAILS`, or a WorkOS access token of an admin user
4. Without an environment override, the script tries prod, dev, then staging and reports which backend succeeded. Use `--env prod|dev|staging` or `MENTRA_CORE_URL` to target one backend explicitly.

What you get:

- `report.json` - Full report document: `kind` (bug/feedback/automatic), `trigger`, `report` (actual/expected behavior, severity, contact email), `feedback`, `context` (phone/glasses/app state snapshot), artifact metadata, and asset rows
- `NN-logs-{source}.json` - Log bundles uploaded by the devices (e.g. phone, glasses), each `{entries: [{timestamp, level, message, source?}]}`
- `NN-screenshot-phone-*.{png,jpg}` - Screenshots attached by the user

Other modes: `--json` prints the raw report JSON to stdout (no downloads); `--list [--kind ...] [--status ...] [--limit N]` lists recent reports.

Example:

```bash
export MENTRA_ADMIN_TOKEN=msk_your-admin-key
./scripts/fetch-incident-logs.sh rep_01JZWY3V8N0F2E9GQ4T6KXH5RD
```

Note: the **mentra-console** MCP server (`cloud/packages/console-mcp`, tools `incident_get` / `incident_get_logs`) still targets the legacy V1 incidents API (`/api/agent/incidents`, `X-Agent-Key`) and has not been ported to the V2 reports API yet.

## Mentra Live BES firmware (sibling repo)

Glasses MCU firmware lives in the sibling `mentra-live-bes` repo, not this monorepo. Follow that repo's `AGENTS.md` when changing it.

After **every** BES firmware source change, run the OTA sanity gates in that repo (`./build_pz.sh OTA` or `python3 tools/verify_ota_build.py …`). A successful compile is not enough: a raw `best1502x_ibrt_bpone.bin` **>= 1,966,080 bytes** will brick a device that receives it via OTA. Do not install or release if that gate fails.

## Additional Documentation

- Mintlify docs: `/mintlify-docs/`
- Architecture specs, design docs, and working notes: `/notes/` (convention: [`notes/README.md`](notes/README.md))
- Module-specific implementation details: See module-specific `AGENTS.md` files
