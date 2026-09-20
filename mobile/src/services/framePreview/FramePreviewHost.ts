import {findNodeHandle, type View} from "react-native"

import {
  FramePreviewModule,
  type FramePreviewConfigureOptions,
  type FramePreviewDocumentConfig,
  type FramePreviewStatus,
} from "@mentra/frame-preview"

/**
 * Host side of the raw decoded-frame preview experiment.
 *
 * The experiment forks decoded video out of the call pipeline and pushes it into the miniapp's
 * WebView as binary — over a loopback WebSocket on iOS, over a `WebMessageListener` reply proxy
 * on Android. This object owns the one subscription that is allowed to exist, decides who may
 * hold it, and keeps two lifetimes apart:
 *
 *  - The **binding** belongs to a native WebView. On Android the message listener cannot be
 *    added to a document that has already loaded, so the first bind may need one reload; every
 *    later bind of the same view must not ask for another.
 *  - The **document** belongs to one page load. Each new document mints a new token and revokes
 *    the previous page's credit, so a page on its way out cannot keep receiving frames.
 *
 * A page load fires `onLoadEnd` several times (redirects, sub-frames, SPA history), which is
 * why the document generation is bumped from the handshake-reset points the view already has
 * rather than from that callback.
 */
export const FRAME_PREVIEW_PACKAGE = "com.mentra.call"

type Injector = (js: string) => void

interface BindParams {
  packageName: string
  hostView: View | null
  inject: Injector
}

interface HostCommand {
  cmd: string
  args?: Record<string, unknown>
}

class FramePreviewHost {
  private packageName: string | null = null
  private inject: Injector | null = null
  private hostViewTag: number | null = null
  private bound = false
  private installReloadDone = false
  private documentGeneration = 0
  private preparing: Promise<FramePreviewDocumentConfig | null> | null = null
  private preparedFor = -1
  private lastConfig: FramePreviewDocumentConfig | null = null
  private unsupportedReason: string | null = null
  private statusSubscription: {remove: () => void} | null = null
  private stoppedSubscription: {remove: () => void} | null = null

  /** Only the Mentra Call miniapp may hold the experiment's preview subscription. */
  isEligible(packageName: string): boolean {
    return packageName === FRAME_PREVIEW_PACKAGE
  }

  async bind({packageName, hostView, inject}: BindParams): Promise<void> {
    if (!this.isEligible(packageName)) return
    const tag = hostView ? findNodeHandle(hostView) : null
    if (tag == null) {
      console.warn("FramePreviewHost: no native tag for the miniapp host view")
      return
    }
    // Re-binding the same view is a no-op by design; the native side keys the listener on the
    // WebView identity so this cannot stack listeners or ask for a second reload.
    this.packageName = packageName
    this.inject = inject
    this.hostViewTag = tag
    this.attachEvents()

    try {
      const result = await FramePreviewModule.bind({hostViewTag: tag, packageName})
      this.bound = result.supported
      this.unsupportedReason = result.supported ? null : (result.unavailableReason ?? "unsupported")
      if (!result.supported) {
        console.warn(`FramePreviewHost: unavailable (${this.unsupportedReason})`)
        return
      }
      if (result.installReloadRequired && !this.installReloadDone) {
        this.installReloadDone = true
        // Exactly once per view. Signalled to the caller through the returned flag rather than
        // reloading from here, so the view keeps ownership of its own load state.
        this.pendingInstallReload = true
      }
    } catch (error) {
      this.bound = false
      this.unsupportedReason = String(error)
      console.warn("FramePreviewHost: bind failed", error)
    }
  }

  /** True once, when the native listener needs a reload to appear in the current document. */
  pendingInstallReload = false

  consumeInstallReload(): boolean {
    const pending = this.pendingInstallReload
    this.pendingInstallReload = false
    return pending
  }

  /**
   * A genuinely new document. Invalidates the previous page's token and outstanding credit.
   * Safe to call more often than strictly necessary; preparation is keyed on the generation.
   */
  beginDocument(): void {
    this.documentGeneration += 1
    this.preparing = null
    this.preparedFor = -1
    this.lastConfig = null
    void FramePreviewModule.stop("new_document").catch(() => undefined)
  }

  /** Handle a `frame_preview` envelope posted by the page. */
  handleCommand(packageName: string, command: HostCommand): void {
    if (!this.isEligible(packageName)) return
    switch (command.cmd) {
      case "handshake":
        void this.sendConfig()
        break
      case "configure":
        void FramePreviewModule.configure(command.args as unknown as FramePreviewConfigureOptions).catch((error) =>
          console.warn("FramePreviewHost: configure failed", error),
        )
        break
      case "start":
        void FramePreviewModule.start().catch((error) => console.warn("FramePreviewHost: start failed", error))
        break
      case "stop":
        void FramePreviewModule.stop(String(command.args?.reason ?? "page")).catch(() => undefined)
        break
      case "resetStats":
        void FramePreviewModule.resetStats().catch(() => undefined)
        break
      case "rendererError":
        console.warn(`FramePreviewHost: renderer error — ${String(command.args?.message ?? "unknown")}`)
        break
      default:
        console.warn(`FramePreviewHost: unknown command ${command.cmd}`)
    }
  }

  /** Halt frame production. The transport and the page's authentication survive. */
  stop(reason: string): void {
    if (!this.bound) return
    void FramePreviewModule.stop(reason).catch(() => undefined)
  }

  /** Destroy the transport as well. The page must handshake again afterwards. */
  async teardown(reason: string): Promise<void> {
    this.detachEvents()
    this.preparing = null
    this.preparedFor = -1
    this.lastConfig = null
    this.bound = false
    this.installReloadDone = false
    this.pendingInstallReload = false
    this.packageName = null
    this.inject = null
    this.hostViewTag = null
    try {
      await FramePreviewModule.unbind()
    } catch {
      // The module may already be gone (content process terminated); nothing to recover.
    }
    console.log(`FramePreviewHost: torn down (${reason})`)
  }

  private async sendConfig(): Promise<void> {
    if (!this.inject) return
    if (!this.bound) {
      this.post({
        t: "config",
        supported: false,
        transport: "webmessage",
        token: "",
        docGen: this.documentGeneration,
        sessionGen: 0,
        unavailableReason: this.unsupportedReason ?? "not_bound",
      })
      return
    }

    // Idempotent per document: a page that asks twice gets the same credential rather than
    // invalidating the credit it is already using.
    if (this.preparedFor === this.documentGeneration && this.lastConfig) {
      this.post(this.lastConfig)
      return
    }
    if (!this.preparing) {
      const generation = this.documentGeneration
      this.preparing = FramePreviewModule.prepareDocument({docGen: generation})
        .then((config) => {
          if (generation !== this.documentGeneration) return null
          this.preparedFor = generation
          this.lastConfig = config
          return config
        })
        .catch((error) => {
          console.warn("FramePreviewHost: prepareDocument failed", error)
          this.preparing = null
          return null
        })
    }
    const config = await this.preparing
    if (!config) return
    this.post({...config, supported: true})
  }

  private attachEvents(): void {
    if (this.statusSubscription) return
    this.statusSubscription = FramePreviewModule.addListener("onStatus", (status: FramePreviewStatus) => {
      this.post(status)
    })
    this.stoppedSubscription = FramePreviewModule.addListener("onStopped", (event: {reason: string}) => {
      this.post({t: "stopped", reason: event.reason})
    })
  }

  private detachEvents(): void {
    this.statusSubscription?.remove()
    this.statusSubscription = null
    this.stoppedSubscription?.remove()
    this.stoppedSubscription = null
  }

  private post(payload: unknown): void {
    const inject = this.inject
    if (!inject) return
    // The page installs this global before it asks for a handshake; guarding here keeps a
    // mid-navigation injection from throwing inside the WebView.
    inject(`window.__mentraFramePreview && window.__mentraFramePreview.onHost(${JSON.stringify(payload)});true;`)
  }
}

const framePreviewHost = new FramePreviewHost()
export default framePreviewHost
