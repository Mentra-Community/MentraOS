#!/usr/bin/env zx

import "zx/globals"
import {readFile, writeFile} from "fs/promises"
import {setBuildEnv} from './set-build-env.mjs';
await setBuildEnv();

// build only for real devices new arch:
process.env.ORG_GRADLE_PROJECT_reactNativeArchitectures = 'arm64-v8a'

// Optional --name <suffix> — produces a parallel-installable build with a
// suffixed package name and matching app label. Validation lives in
// app.config.ts (which reads MENTRAOS_BUILD_NAME). e.g.
//   bun android-release --name stable
//   → applicationId: com.mentra.mentra.stable
//   → app label:     stable
const nameSuffix = argv.name ? String(argv.name).trim() : null
if (nameSuffix) {
  process.env.MENTRAOS_BUILD_NAME = nameSuffix
}

console.log('Building Android release...');
if (nameSuffix) {
  console.log(`  Variant: MENTRAOS_BUILD_NAME=${nameSuffix}`)
}

// Prebuild Android (reads MENTRAOS_BUILD_NAME via app.config.ts)
await $({ stdio: 'inherit' })`bun expo prebuild --platform android`;

// Patch the build-time copy of google-services.json to include a client entry
// for the suffixed package, since Firebase only knows about the base package.
// The cloned entry reuses the base Firebase app ID — fine for local/dev builds.
if (nameSuffix) {
  const gsPath = 'android/app/google-services.json'
  const gs = JSON.parse(await readFile(gsPath, 'utf-8'))
  const newPkg = `com.mentra.mentra.${nameSuffix}`
  const baseClient = gs.client?.find(
    (c) => c.client_info?.android_client_info?.package_name === 'com.mentra.mentra',
  )
  const alreadyHas = gs.client?.some(
    (c) => c.client_info?.android_client_info?.package_name === newPkg,
  )
  if (baseClient && !alreadyHas) {
    const clone = JSON.parse(JSON.stringify(baseClient))
    clone.client_info.android_client_info.package_name = newPkg
    gs.client.push(clone)
    await writeFile(gsPath, JSON.stringify(gs, null, 2))
  }
}

// bundle js code:
await $({stdio: "inherit"})`bun expo export --platform android --clear`

// Build release APK
await $({ stdio: 'inherit', cwd: 'android' })`./gradlew assembleRelease`;

// Install APK on device
await $({ stdio: 'inherit' })`adb install -r android/app/build/outputs/apk/release/app-release.apk`;

console.log('✅ Android release built and installed successfully!');
if (nameSuffix) {
  console.log(`   Package: com.mentra.mentra.${nameSuffix}`)
  console.log(`   App label: ${nameSuffix}`)
}
