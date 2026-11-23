/**
 * Miniapp links: a tap on `https://apps.mentraglass.com/open?url=<miniapp URL>` opens this app (the
 * `@mentra/engine` plugin in app.json claims the link), and so does `exampleoemapp://open?url=…` on the app's own
 * scheme. The host hands the link to the engine and supplies only the confirmation: here a native alert, in a real
 * host its install sheet.
 */
import {engine, InstallMiniappError, MiniappLinkError, type MiniappInstallPreview} from "@mentra/engine"
import {isMiniappLink, isOnMiniappLinkHost} from "@mentra/engine/miniapp-links"
import {Alert, Linking} from "react-native"

import type {EngineLogger} from "./engineRuntime"

/** The app's own URL scheme, as app.json declares it. */
const SCHEMES = ["exampleoemapp"]

/** Mentra's directory, which says which URL serves a package link's package. */
const DIRECTORY_URL = "https://apps.mentraglass.com"

/**
 * Whether a URL opens this app itself: its own scheme, or an address on the link hosts it claims. The engine's
 * `config.isHostLink` takes this, so a miniapp never opens these and none can raise the confirmation below.
 */
export function isHostLink(url: string): boolean {
  return isOnMiniappLinkHost(url, {schemes: SCHEMES})
}

/** Ask the person before anything installs, naming where the miniapp comes from. */
function confirmInstall(preview: MiniappInstallPreview): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      `Install ${preview.name}?`,
      preview.local ? `From your local network (${preview.host})` : `From ${preview.host}`,
      [
        {text: "Cancel", style: "cancel", onPress: () => resolve(false)},
        {text: "Install", onPress: () => resolve(true)},
      ],
      {cancelable: true, onDismiss: () => resolve(false)},
    )
  })
}

async function openMiniappLink(link: string, log: EngineLogger): Promise<void> {
  // The app's other links (a sign-in callback, the development client's own) aren't the engine's to read.
  if (!isMiniappLink(link, {schemes: SCHEMES})) return
  log(`▶ miniapps.installFromLink(${link.split(/[?#]/)[0]})`)
  try {
    const result = await engine.miniapps.installFromLink(link, {
      source: "link",
      schemes: SCHEMES,
      directoryUrl: DIRECTORY_URL,
      confirm: confirmInstall,
    })
    log(`✓ ${result.status} ${result.packageName} ${result.version}`)
  } catch (error) {
    if (error instanceof MiniappLinkError || error instanceof InstallMiniappError) {
      log(`✗ ${error.code}: ${error.message}`)
    } else {
      log(`✗ ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Handle the link that opened the app and every link after it. Listening starts at once, so a link that arrives
 * while the engine is starting isn't lost; each one waits for `engineStarted`, because it installs through the
 * engine. Returns an unsubscribe.
 */
export function listenForMiniappLinks(log: EngineLogger, engineStarted: Promise<unknown>): () => void {
  let listening = true
  const open = (url: string | null) => {
    if (!url) return
    // A failed start has logged its own error; there is no engine to install with.
    void engineStarted.then(
      () => (listening ? openMiniappLink(url, log) : undefined),
      () => undefined,
    )
  }
  const subscription = Linking.addEventListener("url", ({url}) => open(url))
  void Linking.getInitialURL().then(open)
  return () => {
    listening = false
    subscription.remove()
  }
}
