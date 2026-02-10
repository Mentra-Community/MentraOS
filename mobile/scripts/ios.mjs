#!/usr/bin/env zx
import { setBuildEnv } from './set-build-env.mjs';
await setBuildEnv();

// prebuild ios:
await $({stdio: "inherit"})`bun expo prebuild --platform ios`

// copy .env to ios/.xcode.env.local:
await $({stdio: "inherit"})`cp .env ios/.xcode.env.local`

// Run expo iOS command with stdin enabled for interactive prompts
await $({ stdio: 'inherit' })`bun expo run:ios --device`;
