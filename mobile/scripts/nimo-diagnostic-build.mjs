// Explicit commissioning variant. Ordinary release/debug variants keep their source and runtime policy.
export function withNimoDiagnosticGradle(source) {
  const marker = '// NIMO diagnostic variant'
  const generated = source.includes(marker) ? source : source + `
// NIMO diagnostic variant: signed like release, bundled by RN (only debug is a debuggableVariant).
def nimoDiagnosticAssets = layout.buildDirectory.dir('generated/nimoDiagnosticAssets').get().asFile
nimoDiagnosticAssets.mkdirs()
new File(nimoDiagnosticAssets, 'nimo-resource-diagnostic.json').text = '{"schemaVersion":1,"buildType":"nimoDiagnostic","capability":"nimo-resource-v1"}'
android {
    sourceSets { nimoDiagnostic { assets.srcDir nimoDiagnosticAssets } }
    buildTypes {
        nimoDiagnostic {
            initWith release
            debuggable true
            minifyEnabled false
            shrinkResources false
            matchingFallbacks = ['release']
        }
    }
}
`
  // Match RN 0.83's debugOptimized mode: Android remains debuggable/run-as,
  // while C++ headers and release prefab libraries use the same native ABI.
  const nativeRelease = '            externalNativeBuild { cmake { arguments "-DCMAKE_BUILD_TYPE=Release" } }'
  const start = generated.indexOf(marker), prefix = generated.slice(0, start), variant = generated.slice(start)
  if ((generated.match(/\/\/ NIMO diagnostic variant/g) ?? []).length !== 1)
    throw new Error('Cannot safely configure diagnostic native build mode')
  const nativeModes = (variant.match(/CMAKE_BUILD_TYPE/g) ?? []).length
  if (variant.includes(nativeRelease) && nativeModes === 1) return generated
  if (nativeModes !== 0 || (variant.match(/            debuggable true\n/g) ?? []).length !== 1)
    throw new Error('Cannot safely configure diagnostic native build mode')
  return prefix + variant.replace('            debuggable true\n', `            debuggable true\n${nativeRelease}\n`)
}

export function withNimoDiagnosticApplication(source) {
  if (source.includes('BuildConfig.BUILD_TYPE != "nimoDiagnostic"')) return source
  // Expo 55 uses ReactHost, whose developer-support default belongs to RN rather
  // than app BuildConfig. Preserve that default for ordinary variants explicitly.
  const host = /ExpoReactHostFactory\.getDefaultReactHost\(\s*\n/
  if (host.test(source)) {
    if ((source.match(/ExpoReactHostFactory\.getDefaultReactHost\(/g) ?? []).length !== 1 || /\buseDevSupport\s*=/.test(source))
      throw new Error('Cannot safely configure diagnostic developer support in generated ReactHost')
    return source.replace(host, '$&      useDevSupport = (com.facebook.react.common.build.ReactBuildConfig.DEBUG && BuildConfig.BUILD_TYPE != "nimoDiagnostic"),\n')
  }
  // Retain support for the older ReactNativeHost template.
  if (!source.includes('BuildConfig.DEBUG')) throw new Error('Cannot disable diagnostic developer support in generated MainApplication')
  return source.replace(/\bBuildConfig\.DEBUG\b/g, '(BuildConfig.DEBUG && BuildConfig.BUILD_TYPE != "nimoDiagnostic")')
}
