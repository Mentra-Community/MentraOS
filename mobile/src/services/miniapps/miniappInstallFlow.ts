/**
 * Installing a miniapp a person chose: from an open link or a package link, the QR scanner, or the paste box (spec,
 * "Installing"). Every way in ends in the engine's `installMiniapp` with the install sheet as its `confirm`
 * (`MiniappInstallSheet.tsx`), so nothing installs until the person presses Install on a sheet that names where the
 * miniapp comes from. A miniapp can't start this: it never opens the Mentra App's own links (`isMentraAppLink`).
 *
 * - **Installed:** the tile appears on Home.
 * - **Already installed** from that URL: it opens, as a tap on its tile would.
 * - **Errors** say why, in the standard alert sheet. A stop by the age gate (`age_restricted`) shows nothing more:
 *   the engine's age gate asks the person's age and tells them why itself, before the sheet would show.
 */
import {
  engine,
  type InstallMiniappErrorCode,
  type InstallMiniappSource,
  type MiniappInstallPreview,
} from "@mentra/engine"
import {normalizeMiniappUrl} from "@mentra/cloud-protocol/miniapp-url"
import * as WebBrowser from "expo-web-browser"
import Toast from "react-native-toast-message"

import {isOfflineHosted} from "@/components/miniapp/offlineHostedPackages"
import {confirmMiniappInstall} from "@/components/miniapps/MiniappInstallSheet"
import {showAlert, waitForAlertHost} from "@/contexts/ModalContext"
import {translate} from "@/i18n"
import {deploymentStore} from "@/services/deployment"
import {useNavigationStore} from "@/stores/navigation"
import {blockUpdatingMiniapp} from "@/utils/miniappUpdatingAlert"
import {askPermissionsUI} from "@/utils/PermissionsUtils"

import {directoryPackageLink, parseMiniappInstallLink} from "./miniappInstallLinks"

/**
 * How a person's install ended. `installed` and `opened` leave the person in the miniapp or on Home. `cancelled`:
 * nothing changed and they're where they were (they declined, the same install was under way, or the package's page
 * opened in the browser instead).
 */
export type MiniappInstallOutcome = "installed" | "opened" | "cancelled" | "failed"

export interface MiniappInstallFlowOptions {
  /** A package link's package: a URL that serves another package doesn't install. */
  expectedPackageName?: string
  /** Called once, when the flow first shows something (the sheet, an alert, the miniapp) or ends. */
  onPresent?: () => void
}

/** Why an install failed, as the person is told: an engine code, or a failure before the engine ran. */
type FailureKind = InstallMiniappErrorCode | "not_a_link" | "unlisted" | "directory_unreachable" | "unknown"

/** How long a package link waits for the directory. */
const DIRECTORY_TIMEOUT_MS = 15_000

/** Installs under way, by miniapp URL: a second scan or tap of the same link joins nothing and shows nothing. */
const inFlight = new Set<string>()

/**
 * Install from what a person scanned, pasted or opened: an open link, a package link or a miniapp URL. Anything else
 * says it isn't a link to a miniapp.
 */
export async function startMiniappInstallFromLink(
  text: string,
  source: InstallMiniappSource,
  options: Pick<MiniappInstallFlowOptions, "onPresent"> = {},
): Promise<MiniappInstallOutcome> {
  const link = parseMiniappInstallLink(text)
  if (!link) {
    options.onPresent?.()
    await showFailure("not_a_link", {})
    return "failed"
  }
  if (link.kind === "package") return startListedMiniappInstall(link.packageName, source, options)
  return startMiniappInstall(link.url, source, options)
}

/**
 * Install the listed miniapp a package link names: the directory says which URL serves it. Without a directory (a
 * deployment that names none), the package's page opens in the browser.
 */
export async function startListedMiniappInstall(
  packageName: string,
  source: InstallMiniappSource,
  options: Pick<MiniappInstallFlowOptions, "onPresent"> = {},
): Promise<MiniappInstallOutcome> {
  const directoryUrl = deploymentStore.getActive().manifest.artifacts.directoryUrl
  if (!directoryUrl) {
    options.onPresent?.()
    // An in-app browser, which never hands the page's own link back to the app.
    await WebBrowser.openBrowserAsync(directoryPackageLink(packageName)).catch((error) =>
      console.warn(`MiniappInstall: couldn't open ${packageName}'s page`, error),
    )
    // The page closed, and nothing installed or opened in the app: the person is where they were.
    return "cancelled"
  }
  let url: string | null
  try {
    url = await listedMiniappUrl(directoryUrl, packageName)
  } catch (error) {
    console.warn(`MiniappInstall: the directory couldn't look up ${packageName}`, error)
    options.onPresent?.()
    await showFailure("directory_unreachable", {})
    return "failed"
  }
  if (!url) {
    options.onPresent?.()
    await showFailure("unlisted", {})
    return "failed"
  }
  return startMiniappInstall(url, source, {...options, expectedPackageName: packageName})
}

/** Install the miniapp at a miniapp URL, asking through the install sheet. */
export async function startMiniappInstall(
  url: string,
  source: InstallMiniappSource,
  options: MiniappInstallFlowOptions = {},
): Promise<MiniappInstallOutcome> {
  let presented = false
  const present = () => {
    if (presented) return
    presented = true
    options.onPresent?.()
  }
  const target = normalizeMiniappUrl(url)
  if (!target) {
    present()
    await showFailure("not_a_link", {})
    return "failed"
  }
  if (inFlight.has(target.url)) {
    present()
    return "cancelled"
  }
  inFlight.add(target.url)
  const host = hostOf(target.url)
  let name: string | undefined
  let otherPackage = false
  try {
    const result = await engine.miniapps.install(target.url, {
      source,
      confirm: async (preview: MiniappInstallPreview) => {
        name = preview.name
        if (options.expectedPackageName && preview.packageName !== options.expectedPackageName) {
          otherPackage = true
          return false
        }
        present()
        const accepted = await confirmMiniappInstall(preview, installedMiniappName(preview.packageName))
        // The download can take a moment: say it's under way.
        if (accepted) Toast.show({type: "info", text1: translate("miniappInstall:installing", {name: preview.name})})
        return accepted
      },
    })
    present()
    // An install that needed no sheet (the package is installed from that URL already) never met the check above.
    if (options.expectedPackageName && result.packageName !== options.expectedPackageName) {
      console.warn(`MiniappInstall: ${target.url} serves ${result.packageName}, not ${options.expectedPackageName}`)
      await showFailure("unlisted", {})
      return "failed"
    }
    if (result.status === "opened") {
      // Not opened (its permissions declined, an update running, the launch refused): the person stays where they
      // were, and a scanner resumes.
      return (await openInstalledMiniapp(result.packageName)) ? "opened" : "cancelled"
    }
    // Installed (a sheet's install never waits for the miniapp to stop): its tile is on Home now.
    showHome()
    Toast.show({type: "success", text1: translate("miniappInstall:installed", {name: name ?? result.packageName})})
    return "installed"
  } catch (error) {
    present()
    const code = installErrorCode(error)
    if (otherPackage) {
      console.warn(`MiniappInstall: ${target.url} doesn't serve ${options.expectedPackageName}`)
      await showFailure("unlisted", {})
      return "failed"
    }
    if (code === "cancelled") return "cancelled"
    console.warn(`MiniappInstall: ${target.url} did not install (${code ?? "unknown"})`, error)
    await showFailure(code ?? "unknown", {name, host})
    return "failed"
  } finally {
    inFlight.delete(target.url)
  }
}

/** The alert for a failed install, or null when the person has been told already or chose it. */
export function miniappInstallFailureCopy(
  kind: FailureKind,
  context: {name?: string; host?: string},
): {title: string; message: string} | null {
  const title = translate("miniappInstall:failedTitle")
  const host = context.host ?? ""
  const message = (() => {
    switch (kind) {
      case "cancelled":
      case "age_restricted":
        // The person chose it, or the age gate (spec, "Age ratings") has told them why, with the miniapp's rating.
        return null
      case "not_a_link":
        return translate("miniappInstall:notALink")
      case "not_a_miniapp":
        return translate("miniappInstall:notAMiniapp", {host})
      case "domain_mismatch":
        return translate("miniappInstall:domainMismatch")
      case "archived":
      case "unlisted":
        return translate("miniappInstall:unavailable")
      case "needs_newer_app":
        return context.name
          ? translate("miniappInstall:needsNewerApp", {name: context.name})
          : translate("miniappInstall:needsNewerAppUnnamed")
      case "access_denied":
        return translate("miniappInstall:accessDenied", {host})
      case "network":
        return translate("miniappInstall:network", {host})
      case "integrity":
        return translate("miniappInstall:integrity")
      case "signature_invalid":
        return translate("miniappInstall:signatureInvalid")
      case "directory_unreachable":
        return translate("miniappInstall:directoryUnavailable")
      default:
        return translate("miniappInstall:failed")
    }
  })()
  return message === null ? null : {title, message}
}

/** Tell the person why the install failed. Resolves once they close the alert, so a scanner resumes after it. */
async function showFailure(kind: FailureKind, context: {name?: string; host?: string}): Promise<void> {
  const copy = miniappInstallFailureCopy(kind, context)
  if (!copy) return
  await waitForAlertHost()
  await showAlert({...copy, buttons: [{text: translate("common:ok")}]})
}

/**
 * Show Home, where a new tile is. The app's own screens in front of it close (Settings, where the developer scanner
 * is). A miniapp in front stays: closing it would end what it is doing, such as a call; the toast says where the tile
 * is.
 */
function showHome(): void {
  const front = engine.miniapps.list().find((app) => app.foregrounded)
  if (front && isOfflineHosted(front.packageName)) engine.miniapps.clearForeground()
  useNavigationStore.getState().clearHistoryAndGoHome()
}

/**
 * Open an installed miniapp as a tap on its Home tile does: required permissions first. Resolves whether it opened;
 * it goes Home only once the miniapp is starting.
 */
async function openInstalledMiniapp(packageName: string): Promise<boolean> {
  const app = engine.miniapps.list().find((candidate) => candidate.packageName === packageName)
  if (!app || blockUpdatingMiniapp(packageName)) return false
  if ((await askPermissionsUI(app)) !== 1) return false
  try {
    if (!(await engine.miniapps.start(app, {trigger: "user", skipNavigation: true}))) return false
    useNavigationStore.getState().clearHistoryAndGoHome()
    await engine.miniapps.setForeground(packageName)
    return true
  } catch (error) {
    console.warn(`MiniappInstall: couldn't open ${packageName}`, error)
    return false
  }
}

/** The miniapp URL the directory lists for a package, or null when it lists none. Throws when it can't answer. */
async function listedMiniappUrl(directoryUrl: string, packageName: string): Promise<string | null> {
  const lookup = `${directoryUrl.replace(/\/+$/, "")}/api/directory/miniapps/${encodeURIComponent(packageName)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DIRECTORY_TIMEOUT_MS)
  try {
    // The directory is public: the request carries no account, token or cookie.
    const response = await fetch(lookup, {credentials: "omit", signal: controller.signal})
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`The directory answered ${response.status}`)
    const listed = (await response.json()) as {packageName?: unknown; url?: unknown} | null
    if (listed?.packageName !== packageName || typeof listed.url !== "string") return null
    const target = normalizeMiniappUrl(listed.url)
    return target?.kind === "public" ? target.url : null
  } finally {
    clearTimeout(timer)
  }
}

/** The code of an `InstallMiniappError`, or null for any other failure. */
function installErrorCode(error: unknown): InstallMiniappErrorCode | null {
  if (!(error instanceof Error) || error.name !== "InstallMiniappError") return null
  const code = (error as Error & {code?: unknown}).code
  return typeof code === "string" ? (code as InstallMiniappErrorCode) : null
}

/** A miniapp URL's host, with its port: what the error copy names. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The name of the installed copy of a package, as its Home tile shows it; null when none is installed. */
function installedMiniappName(packageName: string): string | null {
  return engine.miniapps.list().find((app) => app.packageName === packageName)?.name ?? null
}
