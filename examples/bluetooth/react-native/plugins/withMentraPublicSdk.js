const { withGradleProperties } = require("expo/config-plugins");

// Build the Bluetooth SDK's Android module with the same dependency shape as
// the public com.mentraglass:bluetooth-sdk artifact. Without this property an
// Expo host builds the shape the Mentra App uses, which also bundles optional
// integrations (local Sherpa-ONNX STT/TTS, Silero VAD, Vuzix) that the public
// SDK leaves out.
module.exports = function withMentraPublicSdk(config) {
  return withGradleProperties(config, (gradleConfig) => {
    const properties = gradleConfig.modResults;
    const existing = properties.find(
      (item) => item.type === "property" && item.key === "mentraPublicSdk",
    );
    if (existing) {
      existing.value = "true";
    } else {
      properties.push({ type: "property", key: "mentraPublicSdk", value: "true" });
    }
    return gradleConfig;
  });
};
