# MentraMerge Integration Guide

This document explains how to work with the MentraMerge app in augmentos_cloud.

## Quick Start

### Development

```bash
# Start ALL services including MentraMerge
bun run dev

# Start ONLY MentraMerge in development mode
bun run merge:dev

# Or use the helper script for ONLY MentraMerge
./manage-merge.sh dev
```

### Production

```bash
# Start ALL services including MentraMerge in production mode
bun run prod

# Start ONLY MentraMerge in production mode
bun run merge:prod

# Or use the helper script for ONLY MentraMerge
./manage-merge.sh prod
```

## Available Commands

### Using bun run

```bash
# Development
bun run merge:dev             # Start in development mode (foreground)
bun run merge:dev:detached    # Start in development mode (background)
bun run merge:dev:build       # Rebuild and start in development mode

# Production
bun run merge:prod            # Start in production mode
bun run merge:prod:build      # Rebuild and start in production mode

# Logs
bun run logs:merge            # View MentraMerge logs
```

### Using manage-merge.sh

```bash
./manage-merge.sh dev           # Start in development mode (foreground)
./manage-merge.sh dev-detached  # Start in development mode (background)
./manage-merge.sh dev-build     # Rebuild and start in development mode
./manage-merge.sh prod          # Start in production mode
./manage-merge.sh prod-build    # Rebuild and start in production mode
./manage-merge.sh logs          # View logs
./manage-merge.sh status        # Check container status
./manage-merge.sh stop          # Stop container
./manage-merge.sh help          # Show help
```

## Directory Structure

MentraMerge and augmentos_cloud should be in the same parent directory:

```
/path/to/AugmentApps/
  ├── augmentos_cloud/
  └── MentraMerge/
```

The docker-compose files expect this structure for volume mounts.

## Configuration

### Environment Variables

MentraMerge requires certain environment variables for full functionality. You can create a .env file in the MentraMerge directory:

```bash
# Required for basic operation
PORT=80
CLOUD_HOST_NAME=cloud
MERGE_API_KEY=your_key_here

# Required for AI functionality (optional, app runs in demo mode without these)
SERPAPI_API_KEY=your_serpapi_key
OPENAI_API_KEY=your_openai_key
```

Without the AI API keys, MentraMerge will run in a limited "demo mode" that doesn't make actual API calls.

## Troubleshooting

1. **Missing Networks**:
   If you see network errors, ensure Docker networks exist:
   ```bash
   docker network create augmentos-network
   docker network create augmentos-network-dev
   ```

2. **Container Already Running**:
   If you get "container already exists" errors:
   ```bash
   docker stop merge
   docker rm merge
   ```

3. **API Key Errors**:
   If you see errors about missing API keys:
   ```
   Error: SerpAPI API key not set
   ```
   Create a .env file in the MentraMerge directory with the required API keys as shown above.

4. **Building Issues**:
   Check build logs:
   ```bash
   docker logs merge
   ```

5. **Path Issues**:
   Ensure both repositories are in the same parent directory as shown above.

## Deployment on Azure VM

1. Clone both repositories in the same parent directory
2. From the augmentos_cloud directory, run:
   ```bash
   ./manage-merge.sh prod
   ```

3. Check container status:
   ```bash
   ./manage-merge.sh status
   ```