import {isDeploymentManagedRelease} from "../runtime/bootstrap"

/**
 * A customer's variant of a Mentra miniapp: the same bundle stamped with the
 * customer's package name and backend (`miniapp.json` `variant`). The stamp is
 * written by Runtime or the stamping tool; see
 * `cloud-v2/packages/runtime/src/services/miniapp-variant.ts`.
 */
export interface MiniappVariant {
  /** The Mentra package the bundle was built as; its host privileges carry over. */
  of: string
  /** The customer's backend, handed to the bundle as its `backendUrl` configuration. */
  backendUrl?: string
}

const PACKAGE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/

/** Read a `variant` stamp; anything malformed is no variant. */
export function parseMiniappVariant(value: unknown): MiniappVariant | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const {of, backendUrl} = value as {of?: unknown; backendUrl?: unknown}
  if (typeof of !== "string" || !PACKAGE_NAME.test(of)) return undefined
  if (backendUrl === undefined) return {of}
  if (typeof backendUrl !== "string") return undefined
  try {
    const url = new URL(backendUrl)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined
  } catch {
    return undefined
  }
  return {of, backendUrl}
}

/**
 * The stamp of an installed release, honored only when the current deployment
 * manages exactly that release: its manifest pinned the stamped bytes by
 * digest, so the workspace admin vouched for the claim. A stamp on any other
 * install (a URL, QR or development build) is ignored.
 */
export function honoredMiniappVariant(
  packageName: string,
  version: string,
  stamp: unknown,
  releaseIdentity: Parameters<typeof isDeploymentManagedRelease>[2],
): MiniappVariant | undefined {
  const variant = parseMiniappVariant(stamp)
  if (!variant || !isDeploymentManagedRelease(packageName, version, releaseIdentity)) return undefined
  return variant
}

/** The package configuration a bundle receives: its stamped backend wins over the manifest's map. */
export function variantConfiguration(
  configuration: Record<string, string>,
  variant: MiniappVariant | undefined,
): Record<string, string> {
  return variant?.backendUrl ? {...configuration, backendUrl: variant.backendUrl} : configuration
}
