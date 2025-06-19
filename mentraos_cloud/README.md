# AugmentOS Cloud

AugmentOS is a cloud-based operating system for smart glasses that enables real-time interactions through Third-Party Applications (TPAs). This repository contains the cloud backend and SDK.

## Quick Start

### Prerequisites

- [Docker](https://www.docker.com/get-started)
- [Bun](https://bun.sh/docs/installation)
- [Node.js](https://nodejs.org/) 18+ (for some tools)

### Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/TeamOpenSmartGlasses/AugmentOS.git
   cd AugmentOS/augmentos_cloud
   ```

2. **Setup Docker network:**
   ```bash
   bun run dev:setup-network
   ```

3. **Start development environment:**
   ```bash
   # Quick setup script (recommended)
   ./scripts/docker-setup.sh
   
   # OR manual setup
   bun run setup-deps
   bun run dev
   ```

4. **View logs:**
   ```bash
   # All logs
   bun run logs
   
   # Cloud service logs
   bun run logs:cloud
   
   # Specific service logs
   bun run logs:service <service-name>
   ```

### Useful Commands

- **Rebuild Docker containers:**
  ```bash
  bun run dev:rebuild
  ```

- **Stop all services:**
  ```bash
  bun run dev:stop
  ```

- **Clean environment (remove volumes and prune):**
  ```bash
  bun run dev:clean
  ```

- **Build shared packages:**
  ```bash
  bun run build
  ```

- **Run linting:**
  ```bash
  cd packages/cloud && bun run lint
  ```

- **Run tests:**
  ```bash
  bun run test
  ```

## Development Workflow

1. **Work on shared packages (SDK, utils, etc.):**
   - Make changes to files in `packages/` directory
   - Run `bun run build` to rebuild

2. **Create/modify a TPA:**
   - Navigate to TPA directory: `cd packages/apps/<app-name>`
   - Start development: `bun run dev`

3. **Deploy to staging:**
   ```bash
   bun run staging:deploy
   ```

## Docker Setup

For a comprehensive guide on running AugmentOS Cloud and TPAs in Docker, see [DOCKER_GUIDE.md](./DOCKER_GUIDE.md).

### Docker Tips

- Each service uses a shared node_modules volume to prevent duplicate installations
- The shared-packages service builds all dependencies first
- Use Dockerfile.dev for development (more optimized for local development)
- Use `dev:rebuild` when changing dependencies or Docker configuration

## Documentation

For detailed documentation, see the `/docs` directory:

- **System Overview**: `docs/0. OVERVIEW.md`
- **Architecture**: `docs/1. SYSTEM-ARCHITECTURE.md`
- **TPA Session Management**: `docs/2. TPA-SESSION-MANAGEMENT.md`
- **Developer Guidelines**: `docs/tpa/DISPLAY-GUIDELINES.md`

## Troubleshooting

- **"Failed to link" errors**: Run `bun run dev:clean` to clean up Docker volumes and restart with `bun run dev:rebuild`
- **Connection issues**: Check network settings with `docker network ls` to verify `augmentos-network-dev` exists
- **Performance issues**: Adjust resource limits in docker-compose.yml if needed
