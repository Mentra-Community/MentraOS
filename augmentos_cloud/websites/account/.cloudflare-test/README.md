# Cloudflare Pages Build Simulator

This directory contains tools to help simulate the Cloudflare Pages build environment locally.

## Usage

To test a build in the Cloudflare Pages environment:

```bash
# Run a standard build test
./.cloudflare-test/test-build.sh

# Run with a clean node_modules (recommended for thorough testing)
./.cloudflare-test/test-build.sh --clean
```

## What This Does

1. It creates a Docker container with Node.js 18.17.1 (same as Cloudflare Pages)
2. Mounts your project into the container
3. Runs `npm ci` to install dependencies exactly as specified in package-lock.json
4. Executes `npm run build` to test your build process

## How It Helps

- Identifies dependency issues that might occur in Cloudflare's environment
- Shows path resolution problems that might not appear in your local environment
- Tests your build process in an environment close to Cloudflare Pages

## Why This Works

Cloudflare Pages uses Node.js 18.17.1 and a clean environment for each build. This setup mimics that
environment closely, allowing you to catch issues before deploying.