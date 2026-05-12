# CLI Local Authentication Setup

This guide explains how to authenticate the MentraOS CLI with your local cloud development environment.

## Overview

The MentraOS CLI uses JWT tokens for authentication. For local development, you can generate a development token that bypasses database validation while maintaining the same security model as production.

## Quick Start

```bash
# From /cloud directory:

# 1. Generate a local CLI API key
bun run scripts/generate-local-cli-key.ts

# 2. Switch CLI to local cloud
cd packages/cli
bun run src/index.ts cloud use local

# 3. Authenticate with the generated token
bun run src/index.ts auth $(cat ../../local-cli-token.txt)

# 4. Test the connection
bun run src/index.ts org list
```

## How It Works

### Authentication Flow

1. **Token Generation**: The script generates a JWT token signed with your `AUGMENTOS_AUTH_JWT_SECRET`
2. **Token Structure**: Contains user email, key ID, and expiration (365 days)
3. **Database Bypass**: The `SKIP_CLI_DB_VALIDATION=true` environment variable allows the CLI middleware to skip database validation for local development
4. **Credential Storage**: Token is saved to `~/.mentra/credentials.json` and used for all CLI commands

### Environment Configuration

The following environment variable is required in `/cloud/.env` for local development:

```bash
# CLI Development (skip database validation for local testing)
SKIP_CLI_DB_VALIDATION=true
```

This allows the CLI authentication middleware to accept valid JWT tokens without checking if they exist in the MongoDB database.

## Token Generation Script

Location: `/cloud/scripts/generate-local-cli-key.ts`

The script:

- Generates a UUID for the key ID
- Creates a JWT payload with type='cli'
- Signs the token with your `AUGMENTOS_AUTH_JWT_SECRET`
- Sets expiration to 365 days from generation
- Saves the token to `local-cli-token.txt`

### Custom Email

Generate a token with a specific email:

```bash
bun run scripts/generate-local-cli-key.ts your-email@example.com
```

## Available CLI Commands

Once authenticated, you can use all CLI commands:

```bash
# Organization management
bun run src/index.ts org list
bun run src/index.ts org create <name>

# App management
bun run src/index.ts app list
bun run src/index.ts app create <name>
bun run src/index.ts app deploy

# Cloud management
bun run src/index.ts cloud list
bun run src/index.ts cloud current
bun run src/index.ts cloud use <cloud>
```

## Cloud Environments

The CLI supports multiple cloud environments defined in `src/config/clouds.yaml`:

```yaml
production:
  name: Production
  url: https://api.mentra.glass
  default: true

staging:
  name: Staging
  url: https://api-staging.mentra.glass

local:
  name: Local Development
  url: http://localhost:8002
```

Switch between clouds:

```bash
bun run src/index.ts cloud use local        # Local development
bun run src/index.ts cloud use staging      # Staging environment
bun run src/index.ts cloud use production   # Production environment
```

## Troubleshooting

### "Authentication failed"

**Cause**: The local cloud server isn't running or the token is invalid.

**Solution**:

```bash
# Ensure cloud server is running
cd /cloud
bun run dev

# Check server health
curl http://localhost:8002/livez

# Regenerate token if needed
bun run scripts/generate-local-cli-key.ts
```

### "Your CLI API key may be invalid or revoked"

**Cause**: The `SKIP_CLI_DB_VALIDATION` environment variable is not set, or the cloud server needs to be restarted.

**Solution**:

```bash
# Verify .env contains the setting
grep SKIP_CLI_DB_VALIDATION /cloud/.env

# Restart cloud server to pick up environment changes
bun run dev:stop && bun run dev
```

### "Connection refused"

**Cause**: The cloud server isn't accessible at `http://localhost:8002`.

**Solution**:

```bash
# Check if the server is running
docker ps | grep cloud

# Check port mapping
docker port dev-cloud-1

# View server logs
bun run logs:cloud
```

## Technical Details

### JWT Token Payload

```typescript
{
  email: "dev@local.test",
  type: "cli",
  keyId: "643b0347-337f-44b0-b0b4-c9423b4ae7a1",
  name: "Local Development Key",
  iat: 1776232150,
  exp: 1807768150
}
```

### Authentication Middleware

Location: `/cloud/packages/cloud/src/api/hono/middleware/cli.middleware.ts`

The middleware:

1. Extracts the `Authorization: Bearer <token>` header
2. Verifies the JWT signature using `AUGMENTOS_AUTH_JWT_SECRET`
3. Validates the token payload structure
4. Checks database for revocation (skipped when `SKIP_CLI_DB_VALIDATION=true`)
5. Attaches CLI context to the request

### API Endpoints

The CLI uses the following API endpoints (all require authentication):

- `GET /api/cli/orgs` - List organizations
- `GET /api/cli/apps` - List apps
- `POST /api/cli/apps` - Create app
- `PUT /api/cli/apps/:id` - Update app

These routes are mounted in `/cloud/packages/cloud/src/hono-app.ts`:

```typescript
const cliRouter = new Hono<AppEnv>();
cliRouter.use("*", authenticateCLI);
cliRouter.use("*", transformCLIToConsole);
cliRouter.route("/apps", consoleAppsApi);
cliRouter.route("/orgs", consoleOrgsApi);
app.route("/api/cli", cliRouter);
```

## Security Considerations

### Local Development Only

The `SKIP_CLI_DB_VALIDATION=true` setting should **NEVER** be used in production. It bypasses the database revocation check, which is a critical security feature.

### Token Security

- Tokens are valid for 365 days
- Store tokens securely in `~/.mentra/credentials.json`
- The local-cli-token.txt file is gitignored
- Regenerate tokens if compromised

### JWT Secret

The CLI authentication uses the same JWT secret as the rest of the cloud infrastructure:

- `CLI_AUTH_JWT_SECRET` (preferred for CLI-specific secret)
- `CONSOLE_AUTH_JWT_SECRET` (fallback)
- `AUGMENTOS_AUTH_JWT_SECRET` (fallback)

In local development, all three fallback to `AUGMENTOS_AUTH_JWT_SECRET`.

## Files Modified/Created

### Created Files

- `/cloud/scripts/generate-local-cli-key.ts` - Token generation script
- `/cloud/local-cli-token.txt` - Generated token (gitignored)
- `~/.mentra/credentials.json` - CLI credentials storage

### Modified Files

- `/cloud/.env` - Added `SKIP_CLI_DB_VALIDATION=true`

### Relevant Code

- `/cloud/packages/cloud/src/api/hono/middleware/cli.middleware.ts` - Authentication middleware
- `/cloud/packages/cloud/src/services/console/cli-keys.service.ts` - CLI key service
- `/cloud/packages/cli/src/config/credentials.ts` - Credential management
- `/cloud/packages/cli/src/config/clouds.ts` - Cloud environment management
- `/cloud/packages/cli/src/commands/auth.ts` - Authentication command
- `/cloud/packages/cli/src/commands/cloud.ts` - Cloud management commands

## Production Authentication

For production environments, CLI API keys must be generated through the developer console at https://console.mentra.glass:

1. Log in to the developer console
2. Navigate to Settings → CLI API Keys
3. Generate a new API key
4. Authenticate the CLI: `mentra auth <token>`

Production keys are stored in MongoDB and can be revoked through the console.
