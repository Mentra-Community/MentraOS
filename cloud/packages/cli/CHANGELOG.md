# Changelog

All notable changes to the Mentra CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2024-01-XX

### Added

#### Core CLI Commands

- **App Management Commands**
  - `mentra app create` - Create new apps with interactive and non-interactive modes
    - Interactive prompts for all required fields with validation
    - Non-interactive mode with command-line flags
    - Package name validation (reverse-domain notation)
    - URL validation for public URLs
    - One-time display of API key on creation
  - `mentra app update` - Update app metadata
    - Interactive mode with current values shown as defaults
    - Non-interactive mode with flags for selective updates
    - Confirmation prompt before applying changes
  - `mentra app delete` - Delete apps with safety confirmations
    - Double confirmation required to prevent accidental deletion
    - `--force` flag to skip confirmations (for automation)
    - Clear warning about irreversible action
  - `mentra app publish` - Publish apps to MentraOS Store
    - Status confirmation before publishing
    - `--force` flag for non-interactive publishing
  - `mentra app api-key` - Regenerate app API keys
    - One-time display of new API key
    - Warning about invalidating existing key
    - Confirmation prompt with `--force` override
  - `mentra app export` - Export app configuration to JSON
    - Export to stdout or file with `-o` flag
    - Includes metadata (exported timestamp, tool version)
    - Excludes sensitive/internal fields
  - `mentra app import` - Import app configuration from JSON
    - Validation of required fields
    - Confirmation prompt before creation
    - Organization selection with `--org` flag
    - One-time display of generated API key

- **Authentication Commands**
  - `mentra auth <token>` - Authenticate with CLI API key
  - `mentra auth whoami` - Display current user information
  - `mentra auth logout` - Clear stored credentials

- **Organization Commands**
  - `mentra org list` - List all organizations
  - `mentra org get <id>` - Get organization details
  - `mentra org switch <id>` - Set default organization

- **Cloud Management Commands**
  - `mentra cloud list` - List available cloud environments
  - `mentra cloud current` - Show currently active cloud
  - `mentra cloud use <cloud>` - Switch between cloud environments
  - `mentra cloud add <key>` - Add custom cloud endpoint
  - `mentra cloud remove <cloud>` - Remove custom cloud

#### Backend Infrastructure

- **CLI Authentication Middleware**
  - JWT token validation for CLI requests
  - Request context transformation (`req.cli` → `req.console`)
  - Secure token verification with configurable secret
  - Proper error handling and status codes
  - Protection against token expiration and revocation

- **CLI Keys Service**
  - Generate CLI API keys with JWT tokens
  - List, retrieve, update, and revoke keys
  - Track key usage (last used timestamp)
  - Automatic cleanup of expired keys
  - Secure token hashing (SHA-256)
  - Key metadata (user agent, IP address)
  - Optional key expiration

- **Console API Endpoints**
  - `GET /api/console/apps` - List apps
  - `POST /api/console/apps` - Create app
  - `GET /api/console/apps/:packageName` - Get app details
  - `PUT /api/console/apps/:packageName` - Update app
  - `DELETE /api/console/apps/:packageName` - Delete app
  - `POST /api/console/apps/:packageName/publish` - Publish app
  - `POST /api/console/apps/:packageName/api-key` - Regenerate API key
  - `POST /api/console/apps/:packageName/move` - Move app between orgs

- **CLI Routes**
  - All console endpoints exposed at `/api/cli/*`
  - Middleware-at-mount-point pattern for code reuse
  - Proper authentication and authorization

#### Security Features

- **Secure Credential Storage**
  - Primary: OS keychain via `Bun.secrets` (macOS Keychain, Linux libsecret, Windows Credential Manager)
  - Fallback: Encrypted file storage with `chmod 600`
  - Environment variable override: `MENTRA_CLI_TOKEN` for CI/CD
  - No plaintext token storage
  - Tokens never logged to console

- **Token Security**
  - Cryptographically secure random key IDs
  - SHA-256 hashing of tokens before storage
  - JWT with configurable expiration
  - Token validation on every request
  - Automatic revocation support

#### Developer Experience

- **Interactive Prompts**
  - User-friendly input prompts with validation
  - Default values shown for updates
  - Confirmation prompts for destructive operations
  - Select menus for multiple-choice options

- **Output Formatting**
  - Colored terminal output with `chalk`
  - Table formatting for list views with `cli-table3`
  - JSON output with `--json` flag for scripting
  - Progress indicators for long operations
  - Clear success/error messages

- **Error Handling**
  - Descriptive error messages
  - Proper exit codes for automation
  - Network error recovery
  - Authentication error guidance
  - Validation errors with helpful hints

#### Testing

- **Unit Tests**
  - API client tests (HTTP methods, error handling)
  - Credentials management tests (storage, retrieval, security)
  - Test coverage for core functionality

- **Integration Tests**
  - CLI middleware authentication tests
  - JWT token validation tests
  - Request context transformation tests
  - CLI keys service tests (generation, validation, revocation)
  - Security tests (hashing, secrets protection)

- **Test Infrastructure**
  - Bun test framework setup
  - Mock implementations for external dependencies
  - Test data management utilities
  - CI/CD test workflows (GitHub Actions)

#### Documentation

- **README.md**
  - Quick start guide
  - Installation instructions
  - Command reference
  - Configuration options
  - Usage examples
  - Troubleshooting guide
  - CI/CD integration examples

- **TESTING.md**
  - Comprehensive testing guide
  - Unit test instructions
  - Integration test setup
  - E2E test scenarios
  - Manual testing checklist
  - CI/CD testing workflows
  - Coverage reporting
  - Test data management

- **CHANGELOG.md**
  - Version history
  - Feature documentation
  - Breaking changes
  - Upgrade notes

#### Multi-Cloud Support

- **Built-in Clouds**
  - Production: `https://api.mentra.glass`
  - Staging: `https://staging-api.mentra.glass`
  - Development: `https://dev-api.mentra.glass`
  - Local: `http://localhost:8002`

- **Custom Clouds**
  - Add custom API endpoints
  - Per-cloud configuration
  - Easy switching between environments

#### CI/CD Support

- **Environment Variables**
  - `MENTRA_CLI_TOKEN` - Skip auth command in CI/CD
  - `MENTRA_API_URL` - Override API endpoint
  - Secure credential handling in pipelines

- **Automation Features**
  - `--force` flags to skip confirmations
  - `--json` output for parsing
  - `--quiet` mode for suppressed output
  - Non-zero exit codes on errors

### Changed

- **API Client**
  - Improved error handling with specific status code handling
  - Automatic retry logic for transient failures
  - Request/response interceptors for auth and error handling
  - Better timeout management

### Fixed

- JWT token expiration handling (only include `exp` when defined)
- 401 Unauthorized errors with proper middleware mounting
- ESLint issues (quote escaping, unused imports)
- Logging format consistency with pino

### Security

- Token hashing with SHA-256
- Secure keychain storage via Bun.secrets
- File permissions enforcement (chmod 600)
- No token exposure in logs or error messages
- JWT secret protection
- Expired token cleanup

## [0.1.0] - Initial Development

### Added

- Basic CLI structure with Commander.js
- Authentication flow skeleton
- App list and get commands
- Organization list command
- Cloud management foundation
- Configuration management
- Credential storage foundation

---

## Upgrade Notes

### From 0.x to 1.0

1. **Regenerate CLI Keys**
   - Old keys from 0.x are not compatible
   - Generate new key in console: Settings → CLI Keys → Generate New Key
   - Re-authenticate: `mentra auth <new-token>`

2. **Configuration Migration**
   - Config location unchanged (`~/.mentra/`)
   - Credential format updated for enhanced security
   - Run `mentra auth logout` then `mentra auth <token>` to migrate

3. **New Commands Available**
   - All Phase 2 commands now implemented
   - Check `mentra app --help` for full list

## Breaking Changes

None in 1.0.0 (first stable release)

## Deprecations

None

## Known Issues

None

## Roadmap

### Future Features (v1.1+)

- [ ] App collaboration commands (share, transfer)
- [ ] Bulk operations (delete multiple, update multiple)
- [ ] App templates and scaffolding
- [ ] Analytics commands (usage stats, metrics)
- [ ] Log streaming from apps
- [ ] WebSocket support for real-time updates
- [ ] Plugin system for custom commands
- [ ] Autocomplete for bash/zsh/fish
- [ ] Configuration profiles (dev, staging, prod)
- [ ] Team management commands

### Under Consideration

- [ ] Interactive TUI mode with full-screen interface
- [ ] App deployment pipeline integration
- [ ] Local development server management
- [ ] Git integration for versioning
- [ ] Backup and restore functionality
- [ ] Migration tools from other platforms

## Contributing

See [CONTRIBUTING.md](../../../CONTRIBUTING.md) for development guidelines.

## License

MIT License - See [LICENSE](../../../LICENSE) for details.
