// Native library. Media stays in native code; publishers consume decoded frames and PCM.

// Load only when this transport is requested. Importing the package does not
// start a native session or require Expo's application entry point.
const native = () => require("expo-modules-core").requireNativeModule("MentraGlassesMediaRelay")
export const glassesHotspot = Object.freeze({
  join: (id, ssid, password, gateway, purpose = "outgoing-client") =>
    native().joinLocalHotspot(id, ssid, password, gateway ?? null, purpose),
  leave: (id) => native().leaveLocalHotspot(id),
})
