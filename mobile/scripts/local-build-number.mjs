#!/usr/bin/env zx
// Pin the build number for LOCAL dev builds (`bun android`).
//
// getBuildNumber() (scripts/build-number.mjs) is derived from Date.now() at
// second resolution, so every `expo prebuild` writes a new `versionCode` into
// android/app/build.gradle and every Gradle run evaluates app.config.ts again
// (:expo-constants:createExpoConfig) with yet another number. On a no-change
// rebuild that alone re-runs the manifest merge, aapt2 link, BuildConfig
// generation, Kotlin/Java compile, dexing and APK packaging of :app.
//
// Release scripts already avoid this by exporting MENTRAOS_PINNED_BUILD_NUMBER
// before prebuild. This helper does the same for local dev builds:
//   - an explicit MENTRAOS_PINNED_BUILD_NUMBER in the environment always wins;
//   - otherwise reuse the versionCode already baked into the generated
//     android/app/build.gradle (stable until the native project is regenerated);
//   - otherwise (fresh checkout / no android dir) pin one fresh timestamp so
//     prebuild and Gradle at least agree with each other.
//
// `expo run:android` installs with `adb install -r -d`, so reusing a number that
// is not strictly increasing cannot break installation on a dev device.
import {readFile} from "node:fs/promises"
import {join} from "node:path"
import {getBuildNumber} from "./build-number.mjs"

export const PINNED_BUILD_NUMBER_ENV = "MENTRAOS_PINNED_BUILD_NUMBER"
const APP_BUILD_GRADLE = join("android", "app", "build.gradle")

export function parseVersionCode(buildGradle) {
  if (typeof buildGradle !== "string") return null
  const match = buildGradle.match(/^\s*versionCode\s+(\d+)\s*$/m)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function parsePinnedEnv(raw) {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export async function pinLocalBuildNumber({
  cwd = process.cwd(),
  env = process.env,
  freshBuildNumber = getBuildNumber,
  log = console.log,
} = {}) {
  const explicit = parsePinnedEnv(env[PINNED_BUILD_NUMBER_ENV])
  if (explicit !== null) {
    return {value: explicit, source: "env"}
  }

  let existing = null
  try {
    existing = parseVersionCode(await readFile(join(cwd, APP_BUILD_GRADLE), "utf8"))
  } catch {
    existing = null
  }

  const value = existing ?? freshBuildNumber()
  const source = existing !== null ? "android-project" : "fresh"
  env[PINNED_BUILD_NUMBER_ENV] = String(value)
  log(`[build-number] pinned ${value} (${source})`)
  return {value, source}
}
