#!/usr/bin/env zx
import { setBuildEnv } from './set-build-env.mjs';
await setBuildEnv();

// prebuild ios:
await $({stdio: "inherit"})`bun expo prebuild --platform ios`

// copy .env to ios/.xcode.env.local:
await $({stdio: "inherit"})`cp .env ios/.xcode.env.local`

// Get connected iOS devices
const xcrunOutput = await $`xcrun xctrace list devices`
const lines = xcrunOutput.stdout.trim().split('\n')

// Find first physical iPhone (physical devices don't have "Simulator" in the line)
const iphoneLine = lines.find(line => 
  line.includes('iPhone') && !line.includes('Simulator')
)

if (!iphoneLine) {
  console.error('No physical iPhone found')
  process.exit(1)
}

// Extract device name (everything before the opening paren with iOS version)
const deviceName = iphoneLine.match(/^(.+?)\s*\(/)?.[1]?.trim()

if (!deviceName) {
  console.error('Could not parse device name')
  process.exit(1)
}

console.log(`Using device: ${deviceName}`)
await $({ stdio: 'inherit' })`bun expo run:ios --device ${deviceName}`;