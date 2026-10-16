import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {withNimoDiagnosticGradle, withNimoDiagnosticApplication} from './nimo-diagnostic-build.mjs'
test('diagnostic has an independent release-derived bundled variant and cannot enable Metro', () => {
  const source = 'override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG'
  const app = withNimoDiagnosticApplication(source)
  assert.match(app, /BuildConfig.DEBUG && BuildConfig.BUILD_TYPE != "nimoDiagnostic"/)
  assert.equal(withNimoDiagnosticApplication(app), app)
  assert.throws(() => withNimoDiagnosticApplication('unrecognized template'))
  const gradle = withNimoDiagnosticGradle('android { buildTypes { release {} } }')
  assert.match(gradle, /nimoDiagnostic \{\n            initWith release/)
  assert.match(gradle, /debuggable true/)
  assert.match(gradle, /capability":"nimo-resource-v1"/)
  assert.equal(withNimoDiagnosticGradle(gradle), gradle)
  assert.equal(gradle.includes('debuggableVariants ='), false)
})

test('the pinned Expo 55 ReactHost template receives a diagnostic-only supported factory argument', async () => {
  // Exact package template from expo@55.0.24/template.tgz; factory API verified in
  // expo@55.0.24/android/src/main/java/expo/modules/ExpoReactHostFactory.kt.
  const source = await readFile(new URL('./fixtures/expo-55.0.24-MainApplication.kt',import.meta.url),'utf8')
  assert.equal(source.includes('BuildConfig.DEBUG'),false)
  const output = withNimoDiagnosticApplication(source)
  const added = '      useDevSupport = (com.facebook.react.common.build.ReactBuildConfig.DEBUG && BuildConfig.BUILD_TYPE != "nimoDiagnostic"),\n'
  assert.equal(output.replace(added,''),source)
  assert.equal(withNimoDiagnosticApplication(output),output)
  assert.throws(()=>withNimoDiagnosticApplication(source.replace('context = applicationContext,','useDevSupport = customPolicy,\n      context = applicationContext,')),/safely/)
  assert.throws(()=>withNimoDiagnosticApplication(source+source),/safely/)
})
