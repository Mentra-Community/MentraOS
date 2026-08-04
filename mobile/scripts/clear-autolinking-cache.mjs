#!/usr/bin/env zx
import {rm} from "fs/promises"

/**
 * Delete the React Native Gradle plugin's cached autolinking config so it is
 * regenerated on the next Gradle run.
 *
 * Why: the plugin caches `android/build/generated/autolinking/autolinking.json`
 * (including `project.android.packageName`, which it bakes into the generated
 * ReactNativeApplicationEntryPoint.java) and only re-runs the resolver when
 * yarn.lock / package-lock.json / package.json / react-native.config.js
 * change. This repo uses bun.lock, which is NOT on that list, so a stale or
 * wrong packageName (e.g. "com.mentra" instead of "com.mentra.mentra")
 * survives indefinitely and breaks :app:compileReleaseJavaWithJavac with
 * "cannot find symbol: class BuildConfig". Regenerating costs a few seconds,
 * a poisoned cache costs a 4-minute failed build.
 */
export async function clearAutolinkingCache() {
  await rm("android/build/generated/autolinking", {recursive: true, force: true})
  await rm("android/app/build/generated/autolinking", {recursive: true, force: true})
}
