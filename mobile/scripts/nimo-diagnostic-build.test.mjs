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

test('diagnostic native CMake mode matches RN debugOptimized release prefabs without changing other variants',()=>{
  const ordinary='android { buildTypes { debug { debuggable true } release { minifyEnabled true } } }'
  const output=withNimoDiagnosticGradle(ordinary)
  const native='            externalNativeBuild { cmake { arguments "-DCMAKE_BUILD_TYPE=Release" } }'
  assert.equal(output.slice(0,ordinary.length),ordinary)
  assert.equal((output.match(/-DCMAKE_BUILD_TYPE=Release/g) ?? []).length,1)
  assert.match(output,/nimoDiagnostic \{\n            initWith release\n            debuggable true\n            externalNativeBuild/)
  assert.match(output,/matchingFallbacks = \['release'\]/)
  assert.equal(withNimoDiagnosticGradle(output),output)
  // Upgrade an already generated prior diagnostic block, not just fresh prebuilds.
  assert.equal(withNimoDiagnosticGradle(output.replace(native+'\n','')),output)
  assert.throws(()=>withNimoDiagnosticGradle(output.replace('-DCMAKE_BUILD_TYPE=Release','-DCMAKE_BUILD_TYPE=Debug')),/safely/)
  assert.throws(()=>withNimoDiagnosticGradle(output.replace(native,native+'\n'+native)),/safely/)
  assert.throws(()=>withNimoDiagnosticGradle(output.replace(native,native+'\n            externalNativeBuild { cmake { arguments \"-DCMAKE_BUILD_TYPE=Debug\" } }')),/safely/)
  assert.throws(()=>withNimoDiagnosticGradle(output+output),/safely/)
})
