import assert from "node:assert/strict"
import test from "node:test"

import {withDebugAbiFilters} from "./android-abi-filters.mjs"

const SAMPLE = `
android {
    namespace "com.mentra.mentra"
    defaultConfig {
        applicationId "com.mentra.mentra"
        minSdkVersion 24
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
        }
    }
}
`

function extractBlock(source, name) {
  const match = source.match(new RegExp(`${name}\\s*\\{([\\s\\S]*?)\\n\\s{4,8}\\}`, "m"))
  return match ? match[0] : ""
}

test("injects the ndk abiFilters block into the debug build type", () => {
  const result = withDebugAbiFilters(SAMPLE)
  const debug = extractBlock(result, "debug")

  assert.match(debug, /MENTRA_DEBUG_ABI_FILTERS/)
  assert.match(debug, /findProperty\("reactNativeArchitectures"\)/)
  assert.match(debug, /abiFilters\(\*abiList\)/)
  assert.match(debug, /\.toString\(\)/)
  assert.match(debug, /findAll \{ !it\.isEmpty\(\) \}/)
})

test("does not add abiFilters to defaultConfig or release", () => {
  const result = withDebugAbiFilters(SAMPLE)
  const defaultConfig = extractBlock(result, "defaultConfig")
  const release = extractBlock(result, "release")

  assert.equal(defaultConfig.includes("abiFilters"), false)
  assert.equal(release.includes("abiFilters"), false)
  assert.equal(release.includes("MENTRA_DEBUG_ABI_FILTERS"), false)
})

test("is idempotent", () => {
  const once = withDebugAbiFilters(SAMPLE)
  const twice = withDebugAbiFilters(once)
  assert.equal(twice, once)
})

test("is a no-op when the debug anchor is absent", () => {
  const missing = `
android {
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
`
  assert.equal(withDebugAbiFilters(missing), missing)
})
