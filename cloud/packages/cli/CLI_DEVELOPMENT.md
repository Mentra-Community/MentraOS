# Mentra CLI Development Guide

## Running the CLI Locally

### Option 1: Direct Execution (Development)

Run the CLI directly without installing:

```bash
# From the cli package directory
cd cloud/packages/cli
bun run src/index.ts [command] [options]

# Examples:
bun run src/index.ts --help
bun run src/index.ts auth <token>
bun run src/index.ts app list
```

### Option 2: Using npm/bun scripts

If defined in package.json, you can use:

```bash
bun run dev [command] [options]
# or
npm run dev [command] [options]
```

## Installing Globally as `mentra`

### Option 1: Link During Development (Recommended)

Link the package globally so you can use `mentra` command anywhere:

```bash
# From the cli package directory
cd cloud/packages/cli

# Link globally
bun link

# OR with npm
npm link
```

Now you can use `mentra` from anywhere:

```bash
mentra --help
mentra auth <token>
mentra app list
```

**To unlink:**

```bash
bun unlink
# OR
npm unlink -g @mentra/cli
```

### Option 2: Global Install from Local Directory

Build and install the package globally:

```bash
# From the cli package directory
cd cloud/packages/cli

# Install globally
npm install -g .
# OR
bun install -g .
```

**To uninstall:**

```bash
npm uninstall -g @mentra/cli
# OR
bun remove -g @mentra/cli
```

### Option 3: Add to PATH (Manual)

Create a symlink or alias:

```bash
# Create a symlink (adjust paths as needed)
sudo ln -s /Users/hiyabuddy/sites/brendancopley/MentraOS/cloud/packages/cli/src/index.ts /usr/local/bin/mentra

# Make it executable
chmod +x /Users/hiyabuddy/sites/brendancopley/MentraOS/cloud/packages/cli/src/index.ts
```

Or add an alias to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
alias mentra="bun run /Users/hiyabuddy/sites/brendancopley/MentraOS/cloud/packages/cli/src/index.ts"
```

Then reload your shell:

```bash
source ~/.zshrc  # or ~/.bashrc
```

## Verifying Installation

Check that the CLI is accessible:

```bash
mentra --version
mentra --help
```

## Package.json Configuration

Ensure your `package.json` has the correct bin configuration:

```json
{
  "name": "@mentra/cli",
  "bin": {
    "mentra": "./dist/index.js"
  }
}
```

If using TypeScript source directly, you might need:

```json
{
  "bin": {
    "mentra": "./src/index.ts"
  }
}
```

And ensure the entry file has a shebang:

```typescript
#!/usr/bin/env node
// or for bun:
#!/usr/bin/env bun
```

## Troubleshooting

### Command not found after linking

1. Check if bun/npm global bin directory is in PATH:

   ```bash
   echo $PATH
   npm config get prefix  # or: bun pm bin -g
   ```

2. Add to PATH if needed (in `~/.zshrc` or `~/.bashrc`):
   ```bash
   export PATH="$PATH:$(npm config get prefix)/bin"
   ```

### Permission denied

Make the entry file executable:

```bash
chmod +x src/index.ts
# or
chmod +x dist/index.js
```

### Changes not reflected

After making code changes:

- If using `bun link`: Changes are reflected immediately (points to source)
- If using global install: Reinstall with `bun install -g .`
- If using built version: Rebuild with `bun run build` first

## Development Workflow

1. Make changes to source files
2. Test locally: `bun run src/index.ts [command]`
3. If linked: `mentra [command]` will use latest source
4. Before committing: Run build and tests
   ```bash
   bun run build
   bun test
   ```
