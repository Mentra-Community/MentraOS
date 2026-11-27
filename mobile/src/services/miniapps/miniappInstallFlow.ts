/**
 * Installing a miniapp a person chose: from an open link or a package link, the QR scanner, or the paste box (spec,
 * "Installing"). Every way in ends in the engine's `installMiniapp`. A miniapp can't start this: it never opens the
 * Mentra App's own links (`isMentraAppLink`).
 *
 * **From a link** the miniapp installs and opens with nothing to press: its splash shows at once
 * (`effects/MiniappLinkOpen.tsx`), and the miniapp opens in place of it. A link that can't be installed closes the
 * splash, leaves the person where they were and says why; nothing is added to Home.
 *
 * **From the scanner or the paste box** the install sheet asks first (`MiniappInstallSheet.tsx`), naming where the
 * miniapp comes from, and the tile then appears on Home. A link asks the same way in two cases: a development build
 * from the local network, and an install that would replace the copy the person has.
 *
 * - **Already installed** from that URL: it opens, as a tap on its tile would.
 * - **Errors** say why, in the standard alert sheet. A stop by the age gate (`age_restricted`) shows nothing more:
 *   the engine's age gate asks the person's age and tells them why itself, before anything installs.
 */
import {
  engine,
  type InstallMiniappErrorCode,
  type InstallMiniappSource,
  type MiniappInstallPreview,
} from "@mentra/engine"
import {fetchListedMiniappUrl} from "@mentra/engine/miniapp-links"
import {normalizeMiniappUrl} from "@mentra/cloud-protocol/miniapp-url"
import * as WebBrowser from "expo-web-browser"
import Toast from "react-native-toast-message"

import {isOfflineHosted} from "@/components/miniapp/offlineHostedPackages"
import {confirmMiniappInstall} from "@/components/miniapps/MiniappInstallSheet"
import {showAlert, waitForAlertHost} from "@/contexts/ModalContext"
import {translate} from "@/i18n"
import {deploymentStore} from "@/services/deployment"
import {beginMiniappLinkOpen, type MiniappLinkOpen} from "@/stores/miniappLinkOpen"
import {type MiniappOpeningAnimation, setMiniappOpeningAnimation} from "@/stores/miniappLaunch"
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
  /**
   * The splash of a link being opened (`startMiniappInstallFromLink` shows it for a link): the miniapp installs
   * without the install sheet and opens in place of the splash.
   */
  opening?: MiniappLinkOpen
}

/** Why an install failed, as the person is told: an engine code, or a failure before the engine ran. */
type FailureKind = InstallMiniappErrorCode | "not_a_link" | "unlisted" | "directory_unreachable" | "unknown"

/** Installs under way, by miniapp URL: a second scan or tap of the same link joins nothing and shows nothing. */
const inFlight = new Set<string>()

/**
 * Install from what a person scanned, pasted or opened: an open link, a package link or a miniapp URL. Anything else
 * says it isn't a link to a miniapp. A link (`source` "link") shows the miniapp's splash from the start, and opens
 * the miniapp once it is installed.
 */
export async function startMiniappInstallFromLink(
  text: string,
  source: InstallMiniappSource,
  options: Pick<MiniappInstallFlowOptions, "onPresent"> = {},
): Promise<MiniappInstallOutcome> {
  const opening = source === "link" ? beginMiniappLinkOpen() : undefined
  try {
    const link = parseMiniappInstallLink(text)
    if (!link) {
      opening?.end()
      options.onPresent?.()
      await showFailure("not_a_link", {})
      return "failed"
    }
    if (link.kind === "package") return await startListedMiniappInstall(link.packageName, source, {...options, opening})
    return await startMiniappInstall(link.url, source, {...options, opening})
  } finally {
    opening?.end()
  }
}

/**
 * Install the listed miniapp a package link names: the directory says which URL serves it. Without a directory (a
 * deployment that names none), the package's page opens in the browser.
 */
export async function startListedMiniappInstall(
  packageName: string,
  source: InstallMiniappSource,
  options: Pick<MiniappInstallFlowOptions, "onPresent" | "opening"> = {},
): Promise<MiniappInstallOutcome> {
  const directoryUrl = deploymentStore.getActive().manifest.artifacts.directoryUrl
  if (!directoryUrl) {
    options.opening?.end()
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
    url = await fetchListedMiniappUrl(directoryUrl, packageName)
  } catch (error) {
    console.warn(`MiniappInstall: the directory couldn't look up ${packageName}`, error)
    if (stoppedByPerson(options)) return "cancelled"
    options.opening?.end()
    options.onPresent?.()
    await showFailure("directory_unreachable", {})
    return "failed"
  }
  if (stoppedByPerson(options)) return "cancelled"
  if (!url) {
    options.opening?.end()
    options.onPresent?.()
    await showFailure("unlisted", {})
    return "failed"
  }
  return startMiniappInstall(url, source, {...options, expectedPackageName: packageName})
}

/**
 * Install the miniapp at a miniapp URL. With `opening` (a link) it installs and opens with nothing to press;
 * otherwise the install sheet asks first, and the tile appears on Home.
 */
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
  // The link's splash, until the install has to ask after all (the sheet shows over where the person was).
  let opening = options.opening
  const target = normalizeMiniappUrl(url)
  if (!target) {
    opening?.end()
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
      isCancelled: () => stoppedByPerson(options),
      confirm: async (preview: MiniappInstallPreview) => {
        name = preview.name
        if (options.expectedPackageName && preview.packageName !== options.expectedPackageName) {
          otherPackage = true
          return false
        }
        // From a link the miniapp installs with nothing to press. A development build from the local network, and
        // an install that replaces the copy the person has, still ask.
        if (opening && !preview.local && !preview.alreadyInstalled) {
          opening.show({name: preview.name, iconUrl: preview.iconUrl})
          return !opening.cancelled
        }
        opening?.end()
        opening = undefined
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
      opening?.end()
      await showFailure("unlisted", {})
      return "failed"
    }
    // The person closed the splash: nothing opens. Whatever installed is on Home.
    if (stoppedByPerson(options)) return "cancelled"
    if (opening) {
      // The miniapp opens in place of its splash, which closes over it. Not opened (its permissions declined, the
      // launch refused): the splash closes on where the person was; a miniapp just installed is on Home.
      const opened = await openInstalledMiniapp(result.packageName, "none", opening)
      opening.end()
      if (result.status === "opened") return opened ? "opened" : "cancelled"
      return "installed"
    }
    if (result.status === "opened") {
      // Not opened (its permissions declined, an update running, the launch refused): the person stays where they
      // were, and a scanner resumes.
      return (await openInstalledMiniapp(result.packageName)) ? "opened" : "cancelled"
    }
    // A development build from the local network (the URL `mentra-miniapp dev` prints) opens, as the developer
    // scanner opens it: a running copy of the release is still on screen otherwise.
    if (target.kind === "local" && (await openInstalledMiniapp(result.packageName))) return "opened"
    // Installed (a sheet's install never waits for the miniapp to stop): its tile is on Home now.
    showHome()
    Toast.show({type: "success", text1: translate("miniappInstall:installed", {name: name ?? result.packageName})})
    return "installed"
  } catch (error) {
    // The person closed the splash: whatever stopped the install after that, there is nothing to tell them.
    if (stoppedByPerson(options)) {
      present()
      return "cancelled"
    }
    // The splash closes before anything says why: nothing was added to Home.
    opening?.end()
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

/** Whether the person closed the splash of the link being opened: nothing more installs, opens or is said. */
function stoppedByPerson(options: Pick<MiniappInstallFlowOptions, "opening">): boolean {
  return options.opening?.cancelled === true
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
 * Open an installed miniapp as a tap on its Home tile does: required permissions first. Resolves whether it opened.
 * Its screen comes to the front as soon as the start is accepted, and only then does the app go Home: the miniapp's
 * splash is up while the start waits for its update check, and a refused start leaves the person where they were.
 * `animation` "none": it appears in place, under the splash it opens from. `opening` is that splash, a link's: it
 * closes once the miniapp's own is under it. Once the person closed it nothing comes to the front, and a miniapp
 * that started meanwhile is stopped again.
 */
async function openInstalledMiniapp(
  packageName: string,
  animation?: MiniappOpeningAnimation,
  opening?: MiniappLinkOpen,
): Promise<boolean> {
  const isStopped = () => opening?.cancelled === true
  const app = engine.miniapps.list().find((candidate) => candidate.packageName === packageName)
  if (!app || blockUpdatingMiniapp(packageName)) return false
  if ((await askPermissionsUI(app)) !== 1) return false
  if (isStopped()) return false
  let presented = false
  const present = async () => {
    if (presented || isStopped()) return
    presented = true
    useNavigationStore.getState().clearHistoryAndGoHome()
    if (animation) setMiniappOpeningAnimation(packageName, animation)
    await engine.miniapps.setForeground(packageName)
    opening?.end()
  }
  // Its screen came up and the start then failed, or was cancelled from that screen: it closes again.
  const dismiss = () => {
    const inFront = engine.miniapps
      .list()
      .some((candidate) => candidate.packageName === packageName && candidate.foregrounded)
    if (presented && inFront) engine.miniapps.clearForeground()
  }
  try {
    if (!(await engine.miniapps.start(app, {trigger: "user", skipNavigation: true, onAccepted: present}))) {
      dismiss()
      return false
    }
    if (isStopped()) {
      await engine.miniapps.stop(packageName)
      return false
    }
    await present()
    return true
  } catch (error) {
    console.warn(`MiniappInstall: couldn't open ${packageName}`, error)
    dismiss()
    return false
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
