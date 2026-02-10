#!/usr/bin/env zx
import {setBuildEnv} from "./set-build-env.mjs"
await setBuildEnv()

// prebuild android:
await $({stdio: "inherit"})`bun expo prebuild --platform android`

// Run expo Android command with stdin enabled for interactive prompts
await $({stdio: "inherit"})`bun expo run:android --device`
