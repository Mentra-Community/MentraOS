import assert from "node:assert/strict"
import {mkdtemp, mkdir, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {PINNED_BUILD_NUMBER_ENV, parsePinnedEnv, parseVersionCode, pinLocalBuildNumber} from "./local-build-number.mjs"

const GRADLE_WITH_VERSION = `
android {
    defaultConfig {
        applicationId 'com.mentra.mentra'
        minSdkVersion rootProject.ext.minSdkVersion
        versionCode 52925218
        versionName "3.2.0"
    }
}
`

async function makeProject(buildGradle) {
  const cwd = await mkdtemp(join(tmpdir(), "local-build-number-"))
  if (buildGradle != null) {
    await mkdir(join(cwd, "android", "app"), {recursive: true})
    await writeFile(join(cwd, "android", "app", "build.gradle"), buildGradle)
  }
  return cwd
}

test("parseVersionCode reads the defaultConfig versionCode", () => {
  assert.equal(parseVersionCode(GRADLE_WITH_VERSION), 52925218)
  assert.equal(parseVersionCode("android {}"), null)
  assert.equal(parseVersionCode("        versionCode 0\n"), null)
  assert.equal(parseVersionCode(undefined), null)
})

test("parseVersionCode ignores commented or inline mentions", () => {
  assert.equal(parseVersionCode("// versionCode 12\n"), null)
  assert.equal(parseVersionCode("def x = versionCode 12\n"), null)
})

test("parsePinnedEnv accepts positive integers only", () => {
  assert.equal(parsePinnedEnv("123"), 123)
  assert.equal(parsePinnedEnv(" 456 "), 456)
  assert.equal(parsePinnedEnv(" "), null)
  assert.equal(parsePinnedEnv("abc"), null)
  assert.equal(parsePinnedEnv("123abc"), null)
  assert.equal(parsePinnedEnv("-5"), null)
  assert.equal(parsePinnedEnv(undefined), null)
})

test("explicit MENTRAOS_PINNED_BUILD_NUMBER wins and is left untouched", async () => {
  const cwd = await makeProject(GRADLE_WITH_VERSION)
  const env = {[PINNED_BUILD_NUMBER_ENV]: "777"}
  const result = await pinLocalBuildNumber({cwd, env, freshBuildNumber: () => 1, log: () => {}})
  assert.deepEqual(result, {value: 777, source: "env"})
  assert.equal(env[PINNED_BUILD_NUMBER_ENV], "777")
})

test("reuses the versionCode already in android/app/build.gradle", async () => {
  const cwd = await makeProject(GRADLE_WITH_VERSION)
  const env = {}
  const logs = []
  const result = await pinLocalBuildNumber({cwd, env, freshBuildNumber: () => 1, log: (m) => logs.push(m)})
  assert.deepEqual(result, {value: 52925218, source: "android-project"})
  assert.equal(env[PINNED_BUILD_NUMBER_ENV], "52925218")
  assert.match(logs[0], /pinned 52925218 \(android-project\)/)
})

test("falls back to one fresh build number when no native project exists", async () => {
  const cwd = await makeProject(null)
  const env = {}
  const result = await pinLocalBuildNumber({cwd, env, freshBuildNumber: () => 424242, log: () => {}})
  assert.deepEqual(result, {value: 424242, source: "fresh"})
  assert.equal(env[PINNED_BUILD_NUMBER_ENV], "424242")
})

test("falls back to fresh when build.gradle has no parseable versionCode", async () => {
  const cwd = await makeProject("android { defaultConfig { versionName '1.0' } }\n")
  const env = {}
  const result = await pinLocalBuildNumber({cwd, env, freshBuildNumber: () => 99, log: () => {}})
  assert.deepEqual(result, {value: 99, source: "fresh"})
})

test("an invalid explicit pin is ignored in favour of the project value", async () => {
  const cwd = await makeProject(GRADLE_WITH_VERSION)
  const env = {[PINNED_BUILD_NUMBER_ENV]: "not-a-number"}
  const result = await pinLocalBuildNumber({cwd, env, freshBuildNumber: () => 1, log: () => {}})
  assert.equal(result.source, "android-project")
  assert.equal(env[PINNED_BUILD_NUMBER_ENV], "52925218")
})

test("a numeric-prefix pin such as 123abc is treated as invalid", async () => {
  const cwd = await makeProject(GRADLE_WITH_VERSION)
  const env = {[PINNED_BUILD_NUMBER_ENV]: "123abc"}
  const result = await pinLocalBuildNumber({cwd, env, freshBuildNumber: () => 1, log: () => {}})
  assert.equal(result.source, "android-project")
  assert.equal(env[PINNED_BUILD_NUMBER_ENV], "52925218")
})
