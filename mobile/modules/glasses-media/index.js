import {requireOptionalNativeModule} from "expo"

function nativeHotspot() {
  const native = requireOptionalNativeModule("MentraGlassesMediaRelay")
  if (!native) throw new Error("Glasses hotspot verification is unavailable in this native build")
  return native
}

/** Observe a user-operated macOS join through the shared hotspot identity/binding policy. */
export const glassesHotspot = Object.freeze({
  waitForMacAssociation: (sessionId, ssid, gateway, timeoutMs) =>
    nativeHotspot().waitForMacAssociation(sessionId, ssid, gateway, timeoutMs),
  verifiedMacAddress: (sessionId) => nativeHotspot().verifiedMacAddress(sessionId),
  releaseMacAssociation: (sessionId) => nativeHotspot().releaseMacAssociation(sessionId),
})
