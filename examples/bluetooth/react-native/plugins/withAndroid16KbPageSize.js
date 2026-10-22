const { withGradleProperties, withProjectBuildGradle } = require("expo/config-plugins");

const CONFIG_BLOCK = `
// Keep release APK native libraries compatible with Android's 16 KB page-size devices.
subprojects { subproject ->
  subproject.plugins.withId("com.android.library") {
    if (subproject.name == "lc3Lib") {
      subproject.android.defaultConfig.externalNativeBuild.cmake.arguments(
        "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON"
      )
    }
  }
}
`;

module.exports = function withAndroid16KbPageSize(config) {
  config = withGradleProperties(config, (gradleConfig) => {
    const property = gradleConfig.modResults.find(
      (item) => item.type === "property" && item.key === "reactNativeArchitectures"
    );
    if (property) {
      property.value = "arm64-v8a,x86_64";
    } else {
      gradleConfig.modResults.push({
        type: "property",
        key: "reactNativeArchitectures",
        value: "arm64-v8a,x86_64",
      });
    }
    return gradleConfig;
  });

  return withProjectBuildGradle(config, (gradleConfig) => {
    if (!gradleConfig.modResults.contents.includes(CONFIG_BLOCK.trim())) {
      gradleConfig.modResults.contents += CONFIG_BLOCK;
    }
    return gradleConfig;
  });
};
