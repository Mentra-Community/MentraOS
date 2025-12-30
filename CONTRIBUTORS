# Contributing to MentraOS

Thank you for your interest in contributing to MentraOS! This guide will help you get started with development and ensure your contributions can be effectively integrated.

## Development Branch

**IMPORTANT**: All development should happen on the `/dev` branch.

- **Base branch**: `dev`
- **Production branch**: `main`
- Create feature branches from `dev`: `git checkout -b feature/your-feature-name`
- Submit pull requests targeting `dev`
- Do NOT commit directly to `main` unless you are a maintainer doing a release

## Quick Start

### Prerequisites

- **Node.js**: ^18.18.0 || >=20.0. (20.x recommended)
- **nvm**: Strongly recommended for managing Node.js versions
- **bun**: Required package manager and runtime (preferred over npm/yarn)
- **Platform-specific**:
  - Android: Android Studio with Java SDK 17
  - iOS: Xcode (macOS only)
  - Cloud: Docker and Docker Compose

### Clone and Setup

```bash
# Clone the repository
git clone https://github.com/Mentra-Community/MentraOS.git
cd MentraOS

# Install bun if you haven't already
curl -fsSL https://bun.sh/install | bash

# Install dependencies (uses bun)
bun install
```

## Project Structure

```
MentraOS/
├── mobile/              # React Native mobile app (Expo)
├── android_core/        # Core Android library
├── sdk_ios/            # iOS native module
├── asg_client/         # Android smart glasses client
├── cloud/              # Backend services, SDK, and web portals
│   ├── packages/
│   │   ├── cloud/      # Main backend service
│   │   ├── sdk/        # TypeScript SDK
│   │   └── websites/   # Web portals (store, console)
└── mcu_client/         # Hardware tooling
```

## Development by Module

### Mobile App Development

The mobile app is built with React Native and Expo.

```bash
cd mobile

# Start development server
bun start

# Run on Android
bun android

# Run on iOS (macOS only)
bun ios

# Run tests
bun test

# Lint code
bun lint

# Type check
bun compile
```

**IMPORTANT**: Never use `--clean` or `--clear` flags with `bun expo prebuild`. This project uses custom native code that would be deleted.

#### Port Forwarding (Android)

```bash
bun adb
```

This sets up port forwarding for local development:

- tcp:9090 (cloud backend)
- tcp:3000 (additional services)
- tcp:9001 (debugging)
- tcp:8081 (Metro bundler)

### Cloud Development

The cloud backend uses Docker and Bun.

```bash
cd cloud

# Quick setup (network, clean, start)
./scripts/docker-setup.sh

# Start development environment
bun run dev

# Build packages
bun run build

# Run tests
bun run test

# View logs
bun run logs              # All services
bun run logs:cloud        # Cloud service only
bun run logs:service <name> # Specific service

# Clean environment
bun run dev:clean
```

#### Environment Setup

Copy `.env.example` to `.env` and configure your environment variables:

```bash
cp .env.example .env
```

**CRITICAL SECURITY WARNING**: Never expose MongoDB publicly without proper authentication and network security measures. MongoDB should:

- Never be directly accessible from the internet
- Use strong authentication (SCRAM-SHA-256)
- Be behind a firewall/VPC in production
- Use TLS/SSL for connections
- Implement IP whitelisting
- Enable MongoDB's built-in role-based access control

#### Docker Tips

- Services use shared node_modules volumes for efficiency
- Use `bun install --no-link` to prevent "Failed to link" errors
- Rebuild with `bun run dev:rebuild` after dependency changes

## Package Manager: Bun

This project uses **Bun** as the package manager and runtime throughout.

### Why Bun?

- Faster installation and execution than npm/yarn
- Native TypeScript support
- Compatible with npm package ecosystem
- Built-in test runner and bundler

### Basic Commands

```bash
# Install dependencies
bun install

# Add a package
bun add <package-name>

# Add dev dependency
bun add -D <package-name>

# Run a script
bun run <script-name>

# Execute a file
bun run <file.ts>

# Run tests
bun test
```

### Install Bun (if needed)

```bash
# macOS/Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
irm bun.sh/install.ps1 | iex
```

## Code Style Guidelines

### TypeScript/JavaScript

- **Formatting**: Prettier with single quotes, no bracket spacing, trailing commas
- **Indentation**: 2 spaces
- **Components**: Functional components with hooks
- **Naming**:
  - PascalCase for components, classes, interfaces, types
  - camelCase for variables and functions
  - UPPER_SNAKE_CASE for constants and environment keys
- **Imports**: Group external/internal, alphabetize within groups
- **Error Handling**: Try/catch with meaningful error messages

### Java/Android

- **Java SDK 17** required
- **Classes**: PascalCase
- **Methods**: camelCase
- **Member variables**: mCamelCase (with m prefix)
- **Constants**: UPPER_SNAKE_CASE
- **Javadoc**: Required for public methods and classes
- **Indentation**: 2 spaces
- **Communication**: EventBus for component communication

### Swift

- Use `swiftformat` for consistent formatting

## Testing

### Unit Tests

```bash
# Mobile
cd mobile && bun test

# Cloud
cd cloud && bun run test

# Run specific test
bun test -- -t "test name"
```

### E2E Tests (Mobile)

```bash
cd mobile
bun test:maestro
```

## Building for Release

### Android

```bash
cd mobile

# Build release APK
bun build:android:release

# Build AAB for Google Play
bun build:google:play

# Upload to Google Play
bun upload:google:play
```

### iOS (macOS only)

```bash
cd mobile

# Build archive
bun build:ios:archive

# Or use Xcode:
open ios/MentraOS.xcworkspace
```

#### Sentry Configuration for iOS Release

Sentry source map and debug symbol uploads require authentication for release builds.

**Obtain Sentry Auth Token**:

1. Visit https://sentry.io/settings/account/api/auth-tokens/
2. Create a new auth token with appropriate permissions

**Enable Sentry Uploads**:

Option 1 - Local development (recommended):

```bash
# Create/edit ios/.xcode.env.local
export SENTRY_AUTH_TOKEN=your_token_here
export SENTRY_DISABLE_AUTO_UPLOAD=false
```

Option 2 - CI/CD pipeline:

```bash
export SENTRY_AUTH_TOKEN=your_token_here
export SENTRY_DISABLE_AUTO_UPLOAD=false
```

**Note**: Sentry uploads are disabled by default to prevent build failures without credentials. The `SENTRY_DISABLE_AUTO_UPLOAD=true` is already set in `ios/.xcode.env` for development builds.

## Commit Guidelines

### Commit Message Format

Use imperative, present-tense commit subjects:

```
Add BLE retry delay
Fix camera permission crash
Refactor session management
Update dependencies
```

### Commit Content

- Keep scope focused on a single logical change
- Reference issue IDs or PR numbers in the body when applicable
- Include configuration updates in the commit description

## Pull Request Guidelines

### Before Submitting

1. **Run tests**: Execute relevant test suites
2. **Build**: Ensure platform builds succeed
3. **Lint**: Run `bun lint` in affected modules
4. **Test flows**: Verify hardware-dependent steps (BLE, camera, etc.)

### PR Description

Include:

- **Scope**: What changes are included
- **Test evidence**: Test results and coverage
- **Logs**: Attach relevant log excerpts for hardware-dependent features
- **Screenshots**: For UI-impacting changes, add screenshots or screen recordings
- **Configuration updates**: Call out any config changes

### Target Branch

Submit all PRs targeting the `dev` branch, not `main`.

## Module-Specific Documentation

Each major module has its own guidelines:

- `/mobile/AGENTS.md` - Mobile app development
- `/cloud/AGENTS.md` - Backend services development
- `/cloud/websites/console/AGENTS.md` - Developer portal
- `/cloud/websites/store/AGENTS.md` - Store frontend

## Architecture Overview

```
┌─────────────────┐         ┌─────────────────┐
│  Smart Glasses  │◄──BLE──►│   Phone App     │
└─────────────────┘         └─────────────────┘
                                      │
                                      │ HTTPS/WebSocket
                                      ▼
                             ┌─────────────────┐
                             │  Cloud Backend  │
                             └─────────────────┘
                                      │
                                      │ WebSocket
                                      ▼
                             ┌─────────────────┐
                             │  Third-party    │
                             │  App Servers    │
                             └─────────────────┘
```

## Getting Help

- **Discord**: https://discord.gg/5ukNvkEAqT
- **GitHub Issues**: https://github.com/Mentra-Community/MentraOS/issues
- **Project Board**: https://github.com/orgs/Mentra-Community/projects/2

## Security Considerations

- Never commit API keys, tokens, or secrets
- Use `.env` files for local configuration (never commit these)
- Mobile secrets belong in `mobile/app.config.ts` or secure config service
- Rebuild native projects after modifying BLE or camera modules
- Follow OWASP guidelines for web applications
- Use parameterized queries to prevent SQL injection
- Sanitize user inputs to prevent XSS attacks

## License

By contributing to MentraOS, you agree that your contributions will be licensed under the same license as the project.
