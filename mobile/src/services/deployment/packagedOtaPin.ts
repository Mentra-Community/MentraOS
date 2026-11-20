/** A CI build's OTA manifest is packaged in app.config's `mentraBuild`, which packaging rewrites without recompiling. A
 * local developer build has none and keeps the pin its .env inlined. */
export function packagedOtaPin(extra: Record<string, unknown> | undefined, environmentPin?: string): string | null {
  if (!extra || !Object.prototype.hasOwnProperty.call(extra, "mentraBuild")) {
    return environmentPin?.trim() || null
  }
  const config = extra.mentraBuild
  if (!config || typeof config !== "object" || !("schemaVersion" in config) || config.schemaVersion !== 2) {
    throw new Error("Unsupported packaged build configuration")
  }
  if (!("otaManifestUrl" in config)) throw new Error("Missing packaged OTA configuration")
  // Unconfigured build intermediates have no OTA target. They are never published.
  if (config.otaManifestUrl === null || config.otaManifestUrl === "") return null
  if (typeof config.otaManifestUrl !== "string" || !/^https?:\/\/[^\s#]+$/.test(config.otaManifestUrl)) {
    throw new Error("Invalid packaged OTA manifest URL")
  }
  const url = new URL(config.otaManifestUrl)
  if (!url.hostname || url.username || url.password) throw new Error("Invalid packaged OTA manifest URL")
  return config.otaManifestUrl
}
