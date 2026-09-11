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

// Install APK on device. Prefer ANDROID_SERIAL; otherwise pick a phone when
// Mentra Live glasses are also attached (adb fails on "more than one device").
const apkPath = 'android/app/build/outputs/apk/release/app-release.apk'
const serial = await resolveAdbSerial()
console.log(`Installing APK on ${serial}...`)
await $({stdio: 'inherit'})`adb -s ${serial} install -r ${apkPath}`

console.log('✅ Android release built and installed successfully!');
if (nameSuffix) {
  console.log(`   Package: com.mentra.mentra.${nameSuffix}`)
  console.log(`   App label: ${nameSuffix}`)
}

async function resolveAdbSerial() {
  if (process.env.ANDROID_SERIAL?.trim()) {
    return process.env.ANDROID_SERIAL.trim()
  }

  const {stdout} = await $`adb devices -l`
  const devices = stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*'))
    .map((line) => {
      const parts = line.split(/\s+/)
      return {serial: parts[0], state: parts[1], raw: line}
    })
    .filter((d) => d.state === 'device')

  if (devices.length === 0) {
    throw new Error('No adb devices ready. Connect a phone and retry.')
  }
  if (devices.length === 1) {
    return devices[0].serial
  }

  const phones = devices.filter((d) => !/MentraLive|Mentra_Live/i.test(d.raw))
  if (phones.length === 1) {
    console.log(
      `Multiple adb devices; installing on phone ${phones[0].serial} (skipping Mentra Live)`,
    )
    return phones[0].serial
  }

  const list = devices.map((d) => `  ${d.raw}`).join('\n')
  throw new Error(
    `Multiple adb devices; set ANDROID_SERIAL to choose one:\n${list}`,
  )
}
