// Native library. Media stays in native code; publishers consume decoded frames and PCM.

// Load only when this transport is requested. Importing the package does not
// start a native session or require Expo's application entry point.
const native = () => require("expo-modules-core").requireNativeModule("MentraGlassesMediaRelay")

// Native relay, ingest, SoftAP and ACS traces go to the console, which bug reports upload.
// The module survives Fast Refresh, so a reload replaces the previous subscription.
const logSubscriptionKey = Symbol.for("mentra.glasses-media.native-log-console")
const credential =
  /(?<![A-Za-z0-9])(?:token|password|passphrase|secret|authorization|key)(?![A-Za-z0-9])\s*["']?\s*[:=]\s*["']?\S+|(?<![A-Za-z0-9])bearer\s+\S+/i
// The host calls this at startup: with Metro's inline requires, importing this package
// does not run its body until something here is used.
export function installNativeLogConsole() {
  const logSource = require("expo-modules-core").requireOptionalNativeModule("MentraGlassesMediaRelay")
  if (!logSource) return
  logSource[logSubscriptionKey]?.remove()
  logSource[logSubscriptionKey] = logSource.addListener("onNativeLog", ({message}) => {
    console.log("[native:glasses-media]", credential.test(message) ? "[REDACTED]" : message.slice(0, 16_384))
  })
}

export const glassesHotspot = Object.freeze({
  join: (id, ssid, password, gateway, purpose = "outgoing-client") =>
    native().joinLocalHotspot(id, ssid, password, gateway ?? null, purpose),
  leave: (id, waitForInternet = false) => native().leaveLocalHotspot(id, waitForInternet),
  onPermissionRequired: (listener) =>
    native().addListener("onLocalHotspotPermissionRequired", (event) =>
      listener(event.id, event.systemAnswer ?? "unknown"),
    ),
})
