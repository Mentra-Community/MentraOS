# CLI Testing Guide

This document provides comprehensive testing instructions for the Mentra CLI tool.

## Table of Contents

- [Running Tests](#running-tests)
- [Test Structure](#test-structure)
- [Unit Tests](#unit-tests)
- [Integration Tests](#integration-tests)
- [End-to-End Tests](#end-to-end-tests)
- [Manual Testing](#manual-testing)
- [CI/CD Testing](#cicd-testing)
- [Coverage Reports](#coverage-reports)

## Running Tests

### Run All Tests

```bash
cd cloud/packages/cli
bun test
```

### Run Specific Test File

```bash
bun test test/api-client.test.ts
```

### Run Tests in Watch Mode

```bash
bun test --watch
```

### Run Tests with Coverage

```bash
bun test --coverage
```

## Test Structure

```
cloud/packages/cli/
├── test/
│   ├── api-client.test.ts          # API client unit tests
│   ├── credentials.test.ts         # Credential management tests
│   └── integration/                # Integration tests (future)
│       ├── auth-flow.test.ts
│       ├── app-commands.test.ts
│       └── cloud-switching.test.ts
└── src/
    └── ...
```

## Unit Tests

### API Client Tests (`test/api-client.test.ts`)

Tests for the CLI API client that communicates with the backend.

**What's tested:**

- HTTP method calls (GET, POST, PUT, DELETE)
- Request parameter handling
- Response data extraction
- Error handling and retries

**Run:**

```bash
bun test test/api-client.test.ts
```

### Credentials Tests (`test/credentials.test.ts`)

Tests for secure credential storage and retrieval.

**What's tested:**

- Saving credentials to OS keychain
- Loading credentials from storage
- File fallback when keychain unavailable
- Environment variable override (`MENTRA_CLI_TOKEN`)
- Clearing credentials
- Security (no token leaking in logs)

**Run:**

```bash
bun test test/credentials.test.ts
```

## Integration Tests

Integration tests verify that multiple components work together correctly.

### Backend Middleware Tests

Located in: `cloud/packages/cloud/src/api/middleware/__tests__/`

**CLI Middleware Tests (`cli.middleware.test.ts`):**

- JWT token validation
- Request context attachment
- Error handling
- Security (secret protection)

**Run:**

```bash
cd cloud/packages/cloud
bun test src/api/middleware/__tests__/cli.middleware.test.ts
```

### CLI Keys Service Tests

Located in: `cloud/packages/cloud/src/services/console/__tests__/`

**CLI Keys Service Tests (`console.cli-keys.service.test.ts`):**

- Key generation
- Token validation
- Key listing and retrieval
- Key updates and revocation
- Expiration handling
- Security (hashing, no plaintext storage)

**Run:**

```bash
cd cloud/packages/cloud
bun test src/services/console/__tests__/console.cli-keys.service.test.ts
```

## End-to-End Tests

E2E tests verify complete user workflows from CLI to backend and back.

### Setting Up E2E Tests

1. Start the backend in test mode:

   ```bash
   cd cloud/packages/cloud
   bun run dev
   ```

2. Set up test credentials:

   ```bash
   cd cloud/packages/cli
   bun run scripts/generate-test-token.ts
   ```

3. Export test token:
   ```bash
   export MENTRA_CLI_TOKEN=<generated-token>
   ```

### E2E Test Scenarios

#### Scenario 1: Authentication Flow

```bash
# Generate CLI key in console
# Authenticate via CLI
mentra auth <token>

# Verify authentication
mentra auth whoami

# Should display user email and key info
```

**Expected:**

- ✅ Token saved securely
- ✅ User info displayed
- ✅ Subsequent commands work without re-auth

#### Scenario 2: App Lifecycle

```bash
# Create app
mentra app create \
  --package-name com.test.e2e \
  --name "E2E Test App" \
  --app-type standard \
  --public-url https://example.com

# List apps (should include new app)
mentra app list

# Get app details
mentra app get com.test.e2e

# Update app
mentra app update com.test.e2e --name "Updated E2E App"

# Publish app
mentra app publish com.test.e2e --force

# Regenerate API key
mentra app api-key com.test.e2e --force

# Export app
mentra app export com.test.e2e -o /tmp/e2e-app.json

# Delete app
mentra app delete com.test.e2e --force
```

**Expected:**

- ✅ All commands succeed
- ✅ Data persists between commands
- ✅ Changes reflected immediately
- ✅ Proper error messages on failures

#### Scenario 3: Organization Management

```bash
# List organizations
mentra org list

# Get org details
mentra org get <org-id>

# Switch default org
mentra org switch <org-id>

# List apps (filtered by org)
mentra app list --org <org-id>
```

**Expected:**

- ✅ Org data displayed correctly
- ✅ Org switching persists
- ✅ App filtering works

#### Scenario 4: Cloud Switching

```bash
# List clouds
mentra cloud list

# Switch to staging
mentra cloud use staging

# Verify current cloud
mentra cloud current

# List apps from staging
mentra app list

# Switch back to production
mentra cloud use production
```

**Expected:**

- ✅ Cloud switching works
- ✅ API calls go to correct endpoint
- ✅ Data isolated per cloud

## Manual Testing

### Testing Checklist

#### Authentication

- [ ] `mentra auth <token>` - saves credentials
- [ ] `mentra auth whoami` - displays user info
- [ ] `mentra auth logout` - clears credentials
- [ ] Environment variable `MENTRA_CLI_TOKEN` works
- [ ] Invalid token shows proper error

#### App Management

- [ ] `mentra app list` - displays apps in table
- [ ] `mentra app list --json` - outputs JSON
- [ ] `mentra app get <pkg>` - shows app details
- [ ] `mentra app create` - interactive mode works
- [ ] `mentra app create --flags` - non-interactive works
- [ ] `mentra app update <pkg>` - interactive mode works
- [ ] `mentra app update <pkg> --flags` - non-interactive works
- [ ] `mentra app delete <pkg>` - requires confirmation
- [ ] `mentra app delete <pkg> --force` - skips confirmation
- [ ] `mentra app publish <pkg>` - publishes to store
- [ ] `mentra app api-key <pkg>` - regenerates key (shows once)
- [ ] `mentra app export <pkg>` - outputs JSON
- [ ] `mentra app export <pkg> -o file.json` - saves to file
- [ ] `mentra app import file.json` - creates app from JSON

#### Organization Management

- [ ] `mentra org list` - displays orgs
- [ ] `mentra org get <id>` - shows org details
- [ ] `mentra org switch <id>` - sets default org

#### Cloud Management

- [ ] `mentra cloud list` - shows available clouds
- [ ] `mentra cloud current` - shows active cloud
- [ ] `mentra cloud use <cloud>` - switches cloud
- [ ] `mentra cloud add <key>` - adds custom cloud
- [ ] `mentra cloud remove <cloud>` - removes cloud

#### Error Handling

- [ ] Invalid package name shows proper error
- [ ] Non-existent app shows 404 error
- [ ] Network errors handled gracefully
- [ ] 401 errors show auth message
- [ ] Malformed JSON shows parse error

#### User Experience

- [ ] Colors display correctly
- [ ] Tables formatted properly
- [ ] Progress indicators work
- [ ] Confirmations work correctly
- [ ] Help text is clear and accurate

## CI/CD Testing

### GitHub Actions Workflow

Create `.github/workflows/cli-test.yml`:

```yaml
name: CLI Tests

on:
  push:
    branches: [main, develop]
    paths:
      - "cloud/packages/cli/**"
      - "cloud/packages/cloud/src/api/**"
      - "cloud/packages/cloud/src/services/console/**"
  pull_request:
    branches: [main, develop]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install CLI dependencies
        run: |
          cd cloud/packages/cli
          bun install

      - name: Run CLI unit tests
        run: |
          cd cloud/packages/cli
          bun test

      - name: Install backend dependencies
        run: |
          cd cloud/packages/cloud
          bun install

      - name: Run backend middleware tests
        run: |
          cd cloud/packages/cloud
          bun test src/api/middleware/__tests__/cli.middleware.test.ts

      - name: Run CLI keys service tests
        run: |
          cd cloud/packages/cloud
          bun test src/services/console/__tests__/console.cli-keys.service.test.ts

      - name: Build CLI
        run: |
          cd cloud/packages/cli
          bun run build

      - name: Test CLI installation
        run: |
          cd cloud/packages/cli
          bun link
          mentra --version

  e2e:
    runs-on: ubuntu-latest
    needs: test

    steps:
      - uses: actions/checkout@v3

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1

      - name: Start backend
        run: |
          cd cloud/packages/cloud
          bun install
          bun run dev &
          sleep 10

      - name: Install CLI
        run: |
          cd cloud/packages/cli
          bun install
          bun link

      - name: Run E2E tests
        env:
          MENTRA_CLI_TOKEN: ${{ secrets.TEST_CLI_TOKEN }}
          MENTRA_API_URL: http://localhost:8002
        run: |
          mentra cloud use local
          mentra app list
          # Add more E2E test commands
```

### Local CI/CD Simulation

Test CI/CD locally before pushing:

```bash
# Run all tests
cd cloud/packages/cli
bun test

cd ../cloud
bun test src/api/middleware/__tests__/cli.middleware.test.ts
bun test src/services/console/__tests__/console.cli-keys.service.test.ts

# Build CLI
cd ../cli
bun run build

# Test installation
bun link
mentra --version
```

## Coverage Reports

### Generate Coverage Report

```bash
cd cloud/packages/cli
bun test --coverage
```

### Coverage Goals

| Category    | Target | Current |
| ----------- | ------ | ------- |
| API Client  | 80%+   | TBD     |
| Credentials | 80%+   | TBD     |
| Commands    | 70%+   | TBD     |
| Middleware  | 90%+   | TBD     |
| Services    | 90%+   | TBD     |

### View Coverage HTML Report

```bash
cd cloud/packages/cli
bun test --coverage
open coverage/index.html
```

## Test Data Management

### Test User Setup

Create a test user in the console:

- Email: `cli-test@mentra.glass`
- Generate CLI key
- Save token to `TEST_CLI_TOKEN` environment variable

### Test App Cleanup

Clean up test apps after testing:

```bash
# List all test apps
mentra app list | grep test

# Delete test apps
mentra app delete com.test.* --force
```

### Database Reset (Local Only)

For local development, reset test data:

```bash
cd cloud/packages/cloud
bun run reset-test-db
```

## Troubleshooting Tests

### Issue: Tests Fail with "Auth Required"

**Solution:**

```bash
export MENTRA_CLI_TOKEN=<your-test-token>
```

### Issue: Tests Timeout

**Solution:**

- Increase timeout in test config
- Check if backend is running
- Verify network connectivity

### Issue: Credential Tests Fail

**Solution:**

- Tests may fail if credentials already exist
- Clear credentials before running: `mentra auth logout`
- Or use isolated test config directory

### Issue: Mock Not Working

**Solution:**

```bash
# Clear Bun cache
rm -rf node_modules/.cache
bun install
```

## Writing New Tests

### Test Template

```typescript
import {describe, test, expect, beforeEach, afterEach} from "bun:test"

describe("Feature Name", () => {
  beforeEach(async () => {
    // Setup before each test
  })

  afterEach(async () => {
    // Cleanup after each test
  })

  test("should do something", async () => {
    // Arrange
    const input = "test"

    // Act
    const result = doSomething(input)

    // Assert
    expect(result).toBe("expected")
  })
})
```

### Best Practices

1. **Isolate tests** - Each test should be independent
2. **Clean up** - Remove test data after tests
3. **Use descriptive names** - Test names should explain what they test
4. **Test edge cases** - Include error cases and boundaries
5. **Mock external dependencies** - Don't rely on external services
6. **Keep tests fast** - Unit tests should run in milliseconds
7. **Document complex tests** - Add comments for non-obvious logic

## Resources

- [Bun Test Documentation](https://bun.sh/docs/cli/test)
- [CLI Implementation Spec](./SPEC.md)
- [API Documentation](../cloud/docs/api.md)
- [Contributing Guide](../../../CONTRIBUTING.md)

## Support

For testing issues:

- Open an issue on GitHub
- Ask in Discord: https://discord.gg/5ukNvkEAqT
- Email: support@mentra.glass
