#!/usr/bin/env zx
import { setBuildEnv } from './set-build-env.mjs';

// Set build environment variables
await setBuildEnv();

// Start expo dev client with stdin enabled for interactive prompts
await $({ stdio: 'inherit' })`bun expo start --dev-client`;
