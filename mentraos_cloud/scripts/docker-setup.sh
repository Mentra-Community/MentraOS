#!/bin/bash
set -e

# Define colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}====== AugmentOS Cloud Docker Setup ======${NC}"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Docker is not installed or not in PATH${NC}"
    exit 1
fi

echo -e "${YELLOW}Creating Docker network...${NC}"
docker network create augmentos-network-dev || echo "Network already exists, continuing..."

echo -e "${YELLOW}Cleaning up old Docker resources...${NC}"
docker-compose -f ../docker-compose.dev.yml -p dev down -v || true

echo -e "${YELLOW}Pruning unused Docker resources...${NC}"
docker system prune -f || true

echo -e "${YELLOW}Building new Docker images...${NC}"
cd .. && bun run setup-deps

echo -e "${YELLOW}Starting services...${NC}"
cd .. && docker-compose -f docker-compose.dev.yml -p dev up -d --build --remove-orphans

echo -e "${GREEN}Setup complete!${NC}"
echo -e "${GREEN}Run 'bun run logs' to see container logs${NC}"
echo -e "${GREEN}Run 'bun run logs:cloud' to see just the cloud service logs${NC}"
echo -e "${GREEN}Run 'bun run logs:service <service-name>' to see logs for a specific service${NC}"