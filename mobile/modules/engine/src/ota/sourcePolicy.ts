export interface FirmwareManifestPin {
  readonly url: string
  readonly sha256: string
}

export interface FirmwareSourcePolicy {
  /** Omitted permits the SDK catalogue. False forbids all catalogue/vendor fallback. */
  readonly allowBundled?: boolean
  /** An own property replaces the bundle entry; null explicitly disables this integration's network source. */
  readonly sources?: Readonly<Record<string, FirmwareManifestPin | null>>
}

export function validateFirmwarePin(pin: FirmwareManifestPin): FirmwareManifestPin {
  const url = new URL(pin.url)
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !/^[0-9a-f]{64}$/.test(pin.sha256))
    throw new Error("Firmware manifests require credential-free HTTPS and a SHA-256 pin")
  return {url: url.toString(), sha256: pin.sha256}
}

export function resolveFirmwareSource(
  integrationId: string,
  policy: FirmwareSourcePolicy | undefined,
  bundled: FirmwareManifestPin | null,
): FirmwareManifestPin | null {
  if (policy?.sources && Object.prototype.hasOwnProperty.call(policy.sources, integrationId)) {
    const selected = policy.sources[integrationId]
    return selected ? validateFirmwarePin(selected) : null
  }
  return policy?.allowBundled === false || !bundled ? null : validateFirmwarePin(bundled)
}

export function firmwareSourceIdentity(pin: FirmwareManifestPin | null): string {
  return pin ? JSON.stringify([pin.url, pin.sha256]) : "disabled"
}
