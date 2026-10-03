/** PR packaging changes Expo's app.config asset without changing the JS bundle. */
export function packagedOtaPin(extra: Record<string, unknown> | undefined, environmentPin?: string): string | null {
  if (!extra || !Object.prototype.hasOwnProperty.call(extra, "mentraPrBuild")) {
    return environmentPin?.trim() || null
  }
  const config = extra.mentraPrBuild
  if (!config || typeof config !== "object" || !("schemaVersion" in config) || config.schemaVersion !== 1) {
    throw new Error("Unsupported packaged PR build configuration")
  }
  if (!("otaManifestUrl" in config)) throw new Error("Missing packaged PR OTA configuration")
  // Unconfigured build intermediates have no OTA target. They are never published.
  if (config.otaManifestUrl === null || config.otaManifestUrl === "") return null
  if (typeof config.otaManifestUrl !== "string" || !/^https?:\/\/[^\s#]+$/.test(config.otaManifestUrl)) {
    throw new Error("Invalid packaged PR OTA manifest URL")
  }
  const url = new URL(config.otaManifestUrl)
  if (!url.hostname || url.username || url.password) throw new Error("Invalid packaged PR OTA manifest URL")
  return config.otaManifestUrl
}
