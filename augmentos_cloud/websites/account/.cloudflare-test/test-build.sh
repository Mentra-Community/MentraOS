#!/bin/bash

# Navigate to the script directory
cd "$(dirname "$0")"

# Clean node_modules to ensure we're testing with a clean install
if [ "$1" == "--clean" ]; then
  echo "Cleaning node_modules..."
  rm -rf ../node_modules
fi

# Build the Docker image and run the container
echo "Building Docker image and running build..."
docker-compose up --build

echo ""
echo "Build completed. Check output above for any errors."