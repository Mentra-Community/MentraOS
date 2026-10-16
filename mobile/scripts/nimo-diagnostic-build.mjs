// Explicit commissioning variant. Ordinary release/debug variants keep their source and runtime policy.
export function withNimoDiagnosticGradle(source) {
  if (source.includes('// NIMO diagnostic variant')) return source
  return source + `
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
            matchingFallbacks = ['release']
        }
    }
}
`
}

export function withNimoDiagnosticApplication(source) {
  if (source.includes('BuildConfig.BUILD_TYPE != "nimoDiagnostic"')) return source
  if (!source.includes('BuildConfig.DEBUG')) throw new Error('Cannot disable diagnostic developer support in generated MainApplication')
  return source.replace(/\bBuildConfig\.DEBUG\b/g, '(BuildConfig.DEBUG && BuildConfig.BUILD_TYPE != "nimoDiagnostic")')
}
