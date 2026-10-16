import test from 'node:test'
import assert from 'node:assert/strict'
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
