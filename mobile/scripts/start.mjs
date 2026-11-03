#!/usr/bin/env zx
import { setBuildEnv } from './set-build-env.mjs';
import { startDevMiniapps } from './local-miniapps.mjs';

// Set build environment variables
// A debug build gets the miniapps live instead of packed.
await setBuildEnv({ packMiniapps: false });
// Serve every miniapp of this checkout to the debug build, live.
await startDevMiniapps();

// Start expo dev client with stdin enabled for interactive prompts
await $({ stdio: 'inherit' })`bun expo start --dev-client`;
