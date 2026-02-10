# @mentra/cli

Command-line tool for managing Mentra apps and organizations.

## Installation

```bash
# Install globally with npm
npm install -g @mentra/cli

# Or with bun
bun install -g @mentra/cli
```

**Requirements:**

- Bun 1.3+ (for secure credential storage via OS keychain)
- Node.js 18+ (if using npm)

## Quick Start

### 1. Generate CLI API Key

1. Go to [console.mentra.glass](https://console.mentra.glass)
2. Navigate to **Settings → CLI Keys**
3. Click **Generate New Key**
4. Copy the token (shown only once!)

### 2. Authenticate CLI

```bash
mentra auth <your-token>
```

Credentials are stored securely in your OS keychain (macOS Keychain, Linux libsecret, Windows Credential Manager).

### 3. Start Managing Apps

```bash
# List apps
mentra app list

# Get app details
mentra app get org.example.myapp

# List organizations
mentra org list

# Switch clouds
mentra cloud use staging
```

## Commands

### Authentication

```bash
mentra auth <token>              # Authenticate with CLI API key
mentra auth logout               # Clear credentials
mentra auth whoami               # Show current user info
```

### App Management

```bash
mentra app list [--org <id>]     # List apps
mentra app get <package-name>    # View app details
mentra app create                # Create new app (interactive or with flags)
mentra app update <package-name> # Update app metadata
mentra app delete <package-name> # Delete app (requires confirmation)
mentra app publish <package-name> # Publish to store
mentra app api-key <package-name> # Regenerate API key (shows once!)
mentra app export <package-name>  # Export config to JSON
mentra app import <file>         # Import config from JSON
```

### Organization Management

```bash
mentra org list                  # List organizations
mentra org get [org-id]          # Get org details
mentra org switch <org-id>       # Set default organization
```

### Cloud Management

```bash
mentra cloud list                # List available clouds
mentra cloud current             # Show current cloud
mentra cloud use <cloud>         # Switch cloud environment
mentra cloud add <key>           # Add custom cloud
mentra cloud remove <cloud>      # Remove custom cloud
```

**Built-in clouds:**

- `production` - https://api.mentra.glass (default)
- `staging` - https://staging-api.mentra.glass
- `development` - https://dev-api.mentra.glass
- `local` - http://localhost:8002

**Add custom cloud:**

```bash
mentra cloud add my-cloud --name "My Cloud" --url https://my-cloud.mentra.glass
mentra cloud use my-cloud
```

### Global Options

```bash
--json        # Output JSON (for scripting)
--quiet       # Suppress non-essential output
--verbose     # Show debug information
--no-color    # Disable colored output
```

## Configuration

### Config Directory: `~/.mentra/`

- **`config.json`** - Settings and custom clouds
- **`credentials.json`** - Fallback if Bun.secrets unavailable (chmod 600)
- **OS Keychain** - Primary credential storage (via Bun.secrets)

### Per-Project Config: `.mentrarc`

```json
{
  "packageName": "org.example.myapp",
  "org": "org_abc123"
}
```

Place in your project root to set defaults for that project.

## Environment Variables

```bash
# Override API URL
export MENTRA_API_URL=https://custom-api.mentra.glass

# Use CLI token without auth command (CI/CD)
export MENTRA_CLI_TOKEN=<your-cli-token>
mentra app list  # Works without running 'mentra auth'
```

## CI/CD Usage

### GitHub Actions

```yaml
name: Deploy App

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install Mentra CLI
        run: bun install -g @mentra/cli

      - name: Deploy to Staging
        env:
          MENTRA_CLI_TOKEN: ${{ secrets.MENTRA_CLI_TOKEN }}
        run: |
          mentra cloud use staging
          mentra app list
```

## Examples

### Create an App Interactively

```bash
mentra app create
# Prompts for: package name, name, description, type, URL, logo
```

### Create an App Non-Interactively

```bash
mentra app create \
  --package-name com.example.myapp \
  --name "My App" \
  --description "My awesome app" \
  --app-type standard \
  --public-url https://myapp.example.com \
  --logo-url https://myapp.example.com/logo.png
```

### Update an App

```bash
# Interactive mode - prompts for each field
mentra app update com.example.myapp

# Non-interactive mode with flags
mentra app update com.example.myapp --name "New Name" --description "New description"
```

### Delete an App

```bash
# Requires double confirmation
mentra app delete com.example.myapp

# Skip confirmation with --force (use carefully!)
mentra app delete com.example.myapp --force
```

### Publish an App to the Store

```bash
mentra app publish com.example.myapp

# Skip confirmation prompt
mentra app publish com.example.myapp --force
```

### Regenerate API Key

```bash
# Shows the new API key once - save it immediately!
mentra app api-key com.example.myapp

# Skip confirmation prompt
mentra app api-key com.example.myapp --force
```

### Export App Configuration

```bash
# Export to stdout
mentra app export com.example.myapp

# Export to file
mentra app export com.example.myapp -o myapp.json
```

### Import App Configuration

```bash
# Import from JSON file
mentra app import myapp.json

# Specify organization
mentra app import myapp.json --org org_abc123

# Skip confirmation
mentra app import myapp.json --force
```

### List Apps with JSON Output

```bash
mentra app list --json | jq '.[] | {name, packageName, status: .appStoreStatus}'
```

### Switch Between Clouds

```bash
# Work on staging
mentra cloud use staging
mentra app list

# Switch to production
mentra cloud use production
mentra app list
```

### Manage Multiple Organizations

```bash
# List all orgs
mentra org list

# Switch default org
mentra org switch org_xyz789

# All subsequent commands use this org
mentra app list
```

## Troubleshooting

### Authentication Issues

**Problem:** `✗ Not authenticated`

**Solution:**

```bash
# Re-authenticate
mentra auth <new-token>

# Or use environment variable
export MENTRA_CLI_TOKEN=<your-token>
```

**Problem:** `✗ CLI API key revoked or expired`

**Solution:**
Generate a new key in the console and re-authenticate.

### OS Keychain Issues

**Problem:** `⚠️  OS keychain unavailable, using file-based storage`

This happens if:

- Bun version is older than 1.3
- Running in headless environment (Docker, CI/CD)
- OS keychain service is not available

**Solution:**

- Upgrade to Bun 1.3+, or
- Use file-based storage (less secure but functional), or
- Use `MENTRA_CLI_TOKEN` environment variable in CI/CD

### Cloud Connection Issues

**Problem:** `✗ Failed to connect to API`

**Solution:**

```bash
# Check current cloud
mentra cloud current

# Try switching clouds
mentra cloud use production

# Or override API URL
export MENTRA_API_URL=https://api.mentra.glass
```

## Development

```bash
# Clone the repository
git clone https://github.com/mentra/mentraos.git
cd mentraos/cloud/packages/cli

# Install dependencies
bun install

# Run in development mode
bun run dev

# Build
bun run build

# Test locally
bun run start
```

## Security

- **Credentials** stored in OS keychain (encrypted at rest)
- **Fallback** to file with `chmod 600` if keychain unavailable
- **Tokens** never logged or printed to console
- **Revocation** instant via console UI

## Links

- [Developer Console](https://console.mentra.glass)
- [Documentation](https://docs.mentra.glass)
- [GitHub](https://github.com/mentra/mentraos)
- [Discord Community](https://discord.gg/5ukNvkEAqT)

## License

MIT
