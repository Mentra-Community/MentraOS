const {withPodfile} = require("expo/config-plugins")
const {mergeContents} = require("@expo/config-plugins/build/utils/generateCode")

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
