import {engine, type InstallMiniappErrorCode, type MiniappInstallPreview} from "@mentra/engine"

import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"

/**
 * Installing a miniapp from a local-network address, such as the URL `mentra dev` prints: the install sheet says
 * "From your local network" with the address, and the engine installs it as a development build
 * (`installMiniapp`, spec "Local-network miniapps").
 */

/** The address the sheet names: the URL's host and port. */
export function localMiniappAddress(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The install sheet for a local-network build. Resolves true when the person taps Install. */
export async function confirmLocalMiniappInstall(preview: MiniappInstallPreview): Promise<boolean> {
  const answer = await showAlert({
    title: preview.ageRating ? `${preview.name} · ${preview.ageRating}` : preview.name,
    message: translate("miniappInstall:fromLocalNetwork", {address: localMiniappAddress(preview.url)}),
    buttons: [{text: translate("common:cancel"), style: "cancel"}, {text: translate("miniappInstall:install")}],
  })
  return answer === 1
}

export interface InstalledLocalMiniapp {
  packageName: string
  name: string
  version: string
}

export interface LocalMiniappInstallOptions {
  /**
   * Runs once the person taps Install, before anything installs: a running copy of the package restarts on the new
   * build as it installs, so what it needs (its required permissions) is granted here. False cancels the install.
   */
  beforeInstall?: (preview: MiniappInstallPreview) => Promise<boolean>
}

/**
 * Install the miniapp at a local-network `url`, asking first. Resolves what installed, or null when the person
 * cancelled. Rejects with the engine's `InstallMiniappError` otherwise.
 */
export async function installLocalMiniapp(
  url: string,
  options: LocalMiniappInstallOptions = {},
): Promise<InstalledLocalMiniapp | null> {
  let name: string | undefined
  // The engine reads any failure inside the sheet as a cancellation: a failed preparation is the install's error.
  let preparation: {failed: true; error: unknown} | null = null
  try {
    const result = await engine.miniapps.install(url, {
      source: "local",
      confirm: async (preview) => {
        name = preview.name
        if (!(await confirmLocalMiniappInstall(preview))) return false
        if (!options.beforeInstall) return true
        try {
          return await options.beforeInstall(preview)
        } catch (error) {
          preparation = {failed: true, error}
          return false
        }
      },
    })
    return {packageName: result.packageName, name: name ?? result.packageName, version: result.version}
  } catch (error) {
    if (preparation) throw (preparation as {error: unknown}).error
    if (installErrorCode(error) === "cancelled") return null
    throw error
  }
}

/** The code of an `InstallMiniappError`, or null for any other failure. */
function installErrorCode(error: unknown): InstallMiniappErrorCode | null {
  if (!(error instanceof Error) || error.name !== "InstallMiniappError") return null
  const code = (error as Error & {code?: unknown}).code
  return typeof code === "string" ? (code as InstallMiniappErrorCode) : null
}

/** Alert copy for a local-network install that failed. */
export function localMiniappInstallErrorAlert(error: unknown, url: string): {title: string; message: string} {
  const address = localMiniappAddress(url)
  const title = translate("debugSettings:miniappLocalInstallFailedTitle")
  switch (installErrorCode(error)) {
    case "not_a_miniapp":
      return {title, message: translate("debugSettings:miniappLocalInstallNotAMiniapp", {address})}
    case "network":
      return {title, message: translate("debugSettings:miniappLocalInstallNetwork", {address})}
    case "access_denied":
      return {title, message: translate("debugSettings:miniappLocalInstallAccessDenied")}
    case "needs_newer_app":
      return {title, message: translate("debugSettings:miniappLocalInstallNeedsNewerApp")}
    case "integrity":
      return {title, message: translate("debugSettings:miniappLocalInstallIntegrity")}
    case "signature_invalid":
      return {title, message: translate("debugSettings:miniappLocalInstallSignature")}
    default:
      return {title, message: error instanceof Error ? error.message : String(error)}
  }
}
