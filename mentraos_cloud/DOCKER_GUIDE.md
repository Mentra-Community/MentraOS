# AugmentOS Cloud Docker Guide

This guide explains how to use Docker to run AugmentOS Cloud and TPAs (Third-Party Applications) in a consistent development and production environment.

## Overview

AugmentOS uses a microservices architecture with Docker to manage its various components:

1. **Core Services**: 
   - `cloud`: Main cloud service (port 8002)
   - `flash`: Flash application (port 8011)
   - `dashboard-manager`: Dashboard management (port 8012)
   - `notify`: Notifications (port 8014)
   - `mira`: Mira AI (port 8015)
   - `live-translation`: Live translation (port 8017)

2. **Third-Party Applications (TPAs)**:
   - `live-captions`: Live Captions TPA (port 8020)
   - `merge`: MentraMerge TPA (port 8016)
   - Your custom TPAs like `aughog` (port 8030)

## Directory Structure

```
Augment/
├── AugmentOS/
│   └── augmentos_cloud/  # Core platform services
├── Apps/
│   ├── AugHog/          # AugHog TPA
│   ├── Live-Captions/   # Live-Captions TPA
│   └── MentraMerge/     # MentraMerge TPA
```

## Docker Networks

Three Docker networks are used to separate development and production environments:

- `augmentos-network-dev`: Used for development (dev)
- `augmentos-network-staging`: Used for staging (staging)
- `augmentos-network`: Used for production

Create these networks with:

```bash
docker network create augmentos-network-dev
docker network create augmentos-network-staging
docker network create augmentos-network
```

## Helper Scripts

Use the helper scripts to quickly manage services:

### For TPAs

```bash
# For Live-Captions
./manage-live-captions.sh dev           # Start in development mode
./manage-live-captions.sh with-cloud    # Start Cloud + Live-Captions
./manage-live-captions.sh logs          # View Live-Captions logs
./manage-live-captions.sh stop          # Stop Live-Captions

# For MentraMerge
./manage-merge.sh dev                   # Start in development mode
./manage-merge.sh with-cloud            # Start Cloud + MentraMerge
./manage-merge.sh logs                  # View MentraMerge logs
./manage-merge.sh stop                  # Stop MentraMerge
```

## Development Workflow

1. **Start Core Services Only**:
   ```bash
   docker-compose -f docker-compose.dev.yml -p dev up -d shared-packages cloud
   ```

2. **Start a Specific TPA with Core Services**:
   ```bash
   ./manage-merge.sh with-cloud
   # OR
   ./manage-live-captions.sh with-cloud
   ```

3. **View Logs**:
   ```bash
   docker-compose -f docker-compose.dev.yml -p dev logs -f cloud merge
   ```

4. **Stop Everything**:
   ```bash
   docker-compose -f docker-compose.dev.yml -p dev down
   ```

## Adding a New TPA

To integrate a new TPA with AugmentOS Cloud:

1. **Update Docker Compose**:
   Add your TPA to `docker-compose.dev.yml`:

   ```yaml
   aughog:
     build:
       context: ../../Apps/AugHog
       dockerfile: docker/Dockerfile.dev
     container_name: aughog
     ports:
       - "8030:80"
     environment:
       - PORT=80
       - CLOUD_HOST_NAME=cloud
       - NODE_ENV=development
     volumes:
       - ../../Apps/AugHog:/app
       - /app/node_modules
     command: sh -c "bun install && bun --hot --watch src/index.ts"
     networks:
       - augmentos-network-dev
     depends_on:
       - cloud
   ```

2. **Create a Helper Script**:
   Create a `manage-aughog.sh` script following the pattern of the other helper scripts.

## Environment Setup

### Development Mode

- Uses `docker-compose.dev.yml`
- Hot reload enabled for all services
- Source code is mounted from host
- Ports are mapped to 80XX series (8002, 8010, etc.)

### Production Mode

- Uses `docker-compose.yml`
- Optimized builds with no hot reload
- Ports are mapped to 70XX series (7002, 7010, etc.)

## Troubleshooting

1. **Service Can't Connect to Cloud**:
   - Verify both services are on the same network
   - Check container names match hostnames (e.g., `cloud`, `merge`, etc.)
   - Ensure dependent services are running

2. **Port Conflicts**:
   - Check if ports are already in use with `docker ps` or `netstat -tulpn`
   - Change the published port in the docker-compose file

3. **File Permission Issues**:
   - Check file permissions for mounted volumes
   - Ensure scripts are executable: `chmod +x *.sh`

4. **Volume Mounting Issues**:
   - Verify paths are correct in docker-compose files
   - Check that volumes are properly specified

5. **Cleaning Up**:
   - Remove all containers and volumes: `docker-compose down -v`
   - Remove unused Docker resources: `docker system prune`