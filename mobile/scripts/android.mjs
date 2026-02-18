#!/usr/bin/env zx
import {setBuildEnv} from "./set-build-env.mjs"
await setBuildEnv()

// prebuild android:
await $({stdio: "inherit"})`bun expo prebuild --platform android`

// Get connected devices with details
const adbOutput = await $`adb devices -l`
const lines = adbOutput.stdout.trim().split('\n').slice(1)

// Filter to physical devices that don't contain "live"
const validDevices = lines.filter(line => 
  line.trim() && 
  !line.includes('emulator') && 
  !line.toLowerCase().includes('live') &&
  !line.startsWith('emulator')
)

if (validDevices.length === 0) {
  console.error('No suitable physical device found')
  process.exit(1)
}

if (validDevices.length > 1) {
  console.log('Multiple devices found, launching interactive picker')
  await $({stdio: "inherit"})`bun expo run:android --device`
} else {
  const modelMatch = validDevices[0].match(/model:(\S+)/)
  const deviceName = modelMatch ? modelMatch[1] : validDevices[0].split(/\s+/)[0]
  console.log(`Using device: ${deviceName}`)
  await $({stdio: "inherit"})`bun expo run:android --device ${deviceName}`
}