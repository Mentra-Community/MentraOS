const {withAppBuildGradle, withPodfile} = require("expo/config-plugins")
const {
  createGeneratedHeaderComment,
  mergeContents,
  removeGeneratedContents,
} = require("@expo/config-plugins/build/utils/generateCode")

// Calling is a vendored dynamic framework: its umbrella header and LC_LOAD_DYLIB
// both require Common.framework. Expo otherwise builds Common as a static library.
const commonFramework = `  installer.pod_targets.each do |pod|
    next unless pod.name == 'AzureCommunicationCommon'
    def pod.build_type
      Pod::BuildType.dynamic_framework
    end
    # Calling's Swift interface must import Common through a stable interface,
    # including when the two SDKs have different minimum deployment targets.
    pod.root_spec.pod_target_xcconfig = (pod.root_spec.attributes_hash['pod_target_xcconfig'] || {}).merge(
      'BUILD_LIBRARY_FOR_DISTRIBUTION' => 'YES'
    )
  end`

module.exports = function withAcsMeeting(config) {
  config = withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== "groovy") {
      throw new Error("@mentra/acs-meeting requires a Groovy app/build.gradle")
    }
    // A library cannot enable desugaring for its consuming app. Keep this
    // requirement with ACS, including hosts that do not use the Crust plugin.
    const tag = "acs-core-library-desugaring"
    const contents = removeGeneratedContents(config.modResults.contents, tag) ?? config.modResults.contents
    const desugaring = `android {
    compileOptions {
        coreLibraryDesugaringEnabled true
    }
}
dependencies {
    coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.4'
}`
    config.modResults.contents = [
      contents.trimEnd(),
      createGeneratedHeaderComment(desugaring, tag, "//"),
      desugaring,
      `// @generated end ${tag}`,
      "",
    ].join("\n")
    return config
  })
  return withPodfile(config, (config) => {
    let contents = config.modResults.contents
    const hook = /^\s*pre_install do \|installer\|\s*$/m
    if (!hook.test(contents)) {
      contents += "\npre_install do |installer|\nend\n"
    }
    config.modResults.contents = mergeContents({
      src: contents,
      newSrc: commonFramework,
      tag: "acs-common-framework",
      anchor: hook,
      offset: 1,
      comment: "#",
    }).contents
    return config
  })
}
