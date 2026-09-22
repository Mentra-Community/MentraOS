import assert from "node:assert/strict"
import {createRequire} from "node:module"
import {join} from "node:path"
import test from "node:test"
import {resolveAndroidPackageName} from "./android-package-name.cjs"

const require = createRequire(import.meta.url)
const RN_CONFIG = join(import.meta.dirname, "..", "react-native.config.js")

test("defaults to the Mentra applicationId", () => {
  assert.equal(resolveAndroidPackageName({region: undefined, buildName: undefined}), "com.mentra.mentra")
})

test("china region uses the cn package", () => {
  assert.equal(resolveAndroidPackageName({region: "china", buildName: ""}), "com.mentra.mentra.cn")
})

test("MENTRAOS_BUILD_NAME suffixes the base package the same way as app.config.ts", () => {
  assert.equal(resolveAndroidPackageName({buildName: "stable"}), "com.mentra.mentra.stable")
  assert.equal(resolveAndroidPackageName({buildName: " QA Build "}), "com.mentra.mentra.qabuild")
  assert.equal(resolveAndroidPackageName({region: "china", buildName: "stable"}), "com.mentra.mentra.cn.stable")
})

test("invalid or empty variant names stay on the base package", () => {
  assert.equal(resolveAndroidPackageName({buildName: "1stable"}), "com.mentra.mentra")
  assert.equal(resolveAndroidPackageName({buildName: "bad-name"}), "com.mentra.mentra")
  assert.equal(resolveAndroidPackageName({buildName: "   "}), "com.mentra.mentra")
})

test("react-native.config.js evaluates MENTRAOS_BUILD_NAME at load time", () => {
  const previous = process.env.MENTRAOS_BUILD_NAME
  process.env.MENTRAOS_BUILD_NAME = "stable"
  delete require.cache[RN_CONFIG]
  try {
    assert.equal(require(RN_CONFIG).project.android.packageName, "com.mentra.mentra.stable")
  } finally {
    if (previous === undefined) delete process.env.MENTRAOS_BUILD_NAME
    else process.env.MENTRAOS_BUILD_NAME = previous
    delete require.cache[RN_CONFIG]
  }
})
