import assert from "node:assert/strict"
import {createRequire} from "node:module"
import test from "node:test"

const require = createRequire(import.meta.url)
const withAcsMeeting = require("../modules/acs-meeting/app.plugin.js")

async function applyPlugin(contents, language = "groovy") {
  const config = withAcsMeeting({name: "Test", slug: "test"})
  const result = await config.mods.android.appBuildGradle({
    ...config,
    modRequest: {platform: "android", modName: "appBuildGradle"},
    modResults: {contents, language},
  })
  return result.modResults.contents
}

test("ACS configures a host without Crust and preserves its Gradle settings", async () => {
  const original = `plugins { id 'com.android.application' }
android {
  namespace 'com.example.host'
  compileOptions {
    sourceCompatibility JavaVersion.VERSION_17
    targetCompatibility JavaVersion.VERSION_17
    coreLibraryDesugaringEnabled false
  }
}
dependencies { implementation 'com.example:unrelated:1.0.0' }
`
  const generated = await applyPlugin(original)
  assert.ok(generated.startsWith(original))
  assert.match(generated.slice(original.length), /coreLibraryDesugaringEnabled true/)
  assert.match(generated, /coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.4'/)
  assert.equal(await applyPlugin(generated), generated)
})

test("ACS refreshes its generated block while preserving another plugin's desugaring", async () => {
  const original = `android { compileOptions { coreLibraryDesugaringEnabled true } }
dependencies { coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.4' }
`
  const generated = await applyPlugin(original)
  const stale = generated.replace(/2\.1\.4(?='\n})/, "2.0.0")
  const refreshed = await applyPlugin(stale)
  assert.equal(refreshed, generated)
  assert.equal(refreshed.match(/@generated begin acs-core-library-desugaring/g).length, 1)
})

test("ACS reports unsupported Gradle syntax instead of generating an invalid build", async () => {
  await assert.rejects(applyPlugin("plugins {}", "kotlin"), /requires a Groovy app\/build.gradle/)
})
