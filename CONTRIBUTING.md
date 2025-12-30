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

- **Node.js**: ^18.18.0 || >=20.0.0 (20.x recommended)
- **nvm**: Strongly recommended for managing Node.js versions
- **bun**: Required package manager and runtime (preferred over npm/yarn)
- **Platform-specific**:
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
│   └── ios/            # iOS native code
├── asg_client/         # Android smart glasses client
├── cloud/              # Backend services, SDK, and web portals
│   ├── packages/
│   │   ├── cloud/      # Main backend service
│   │   ├── sdk/        # TypeScript SDK
│   │   └── websites/   # Web portals (store, console, account)
└── mcu_client/         # Hardware tooling
```

## Development by Module

### Mobile App Development

The mobile app is built with React Native and Expo.

```bash
cd mobile

# Start development server
bun start

# Run on iOS (macOS only)
bun ios

# Run tests
bun test

# Lint code
bun lint

# Type check
bun compile
```

#### iOS Development

The `ios/` directory is **generated** by Expo prebuild from your `app.config.ts`. Custom native code lives in `modules/core/` and is linked automatically.

```bash
# Regenerate iOS project from scratch (if needed)
bun expo prebuild --platform ios --clean

# Run on device/simulator
bun ios
```

**Development Build** (`bun ios`):

- Sets build env vars (commit, branch, timestamp)
- Runs prebuild to sync native files
- Installs debug build on device

**Release Build** (`bun ios:release`):

- Sets build env vars
- Runs prebuild
- Creates distributable `.xcarchive` for App Store
- Archive saved to `~/Library/Developer/Xcode/Archives/{date}/`
- Open Xcode → Window → Organizer to upload

### Cloud Development

The cloud backend uses Docker and Bun.

```bash
cd cloud

# Install dependencies
bun install

# Start development environment
bun run dev

# Build packages
bun run build

# Run tests
bun run test

# View logs
bun run logs              # All services

# Clean environment
bun run dev:clean
```

#### Environment Setup

Copy `.env.example` to `.env` and configure your environment variables:

```bash
cp .env.example .env
```

**Security Note**: Never commit `.env` files or expose MongoDB publicly. Use strong authentication and keep databases behind firewalls/VPCs in production.

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

- **Formatting**: Prettier (double quotes, no semicolons, no bracket spacing, trailing commas, 120 char line width)
- **Indentation**: 2 spaces
- **Components**: Functional components with hooks
- **Naming**:
  - PascalCase for components, classes, interfaces, types
  - camelCase for variables and functions
  - UPPER_SNAKE_CASE for constants and environment keys
- **Imports**: Group external/internal, alphabetize within groups
- **Error Handling**: Try/catch with meaningful error messages

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

### iOS (macOS only)

```bash
cd mobile

# Build release archive
bun ios:release

# Or use Xcode directly:
open ios/MentraOS.xcworkspace
```

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
