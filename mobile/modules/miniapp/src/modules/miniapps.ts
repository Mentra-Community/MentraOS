/**
 * @fileoverview MiniappsModule — `session.miniapps`.
 *
 * Discover and control the lifecycle of OTHER miniapps: list, start, open,
 * stop. SYSTEM-only — every call rejects with NOT_PERMITTED unless the caller
 * is a system app (Mentra AI is the first consumer). The action *capability*
 * layer (invoke / handle) lives on `session.actions`, not here — these are
 * operations on the app as a whole, not on a declared action.
 *
 * Installation (`install`, `checkInstallCompatibility`, `uninstall`) is
 * narrower still: the host accepts it only from a Store miniapp bundled with
 * the Mentra App build. The host downloads, verifies, and activates the
 * release through its own installer; the Store only selects the release.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

/** A declared action surfaced by {@link MiniappsModule.list}. */
export interface MiniappActionInfo {
  id: string
  description: string
  /**
   * JSON-Schema input descriptor (the MCP-compatible subset). Maps verbatim
   * to an MCP tool `inputSchema`. Undefined for actions that take no params.
   */
  parameters?: Record<string, unknown>
  /** JSON-Schema descriptor for the structured value returned by the action. */
  outputSchema?: Record<string, unknown>
  /**
   * `persistent` (default) starts the target as normal user-visible activity.
   * `transient` wakes it invisibly for the duration of the invocation only.
   */
  lifecycle: "persistent" | "transient"
}

/**
 * Hardware compatibility for a listed miniapp. Structurally mirrors the host's
 * `CompatibilityResult` so the runtime can pass it straight through.
 */
export interface MiniappCompatibility {
  isCompatible: boolean
  missingRequired: Array<{type: string; level?: string}>
  missingOptional: Array<{type: string; level?: string}>
  warnings: string[]
}

/** One installed miniapp, as surfaced to a system caller. */
export interface MiniappInfo {
  packageName: string
  name: string
  description?: string
  version: string
  running: boolean
  compatibility: MiniappCompatibility
  /** True when this package identity is backed by a ZIP in the Mentra App build. */
  system: boolean
  /** Store package that owns updates of this active release, when it is Store-managed. */
  storeOwnerPackageName?: string
  /** Store the host build assigns to update this bundled package's active release, if any. */
  systemStoreOwnerPackageName?: string
  /** Declared actions (empty if the miniapp declares none). */
  actions: MiniappActionInfo[]
}

export interface ListMiniappsOptions {
  /** Include incompatible miniapps too (default false — compatible-only). */
  includeIncompatible?: boolean
}

export interface MiniappHardwareRequirement {
  type: string
  level: string
  description?: string
}

/** Backend-neutral release request, accepted only from a bundled, host-trusted Store. */
export interface InstallMiniappRequest {
  packageName: string
  version: string
  bundleUrl: string
  /** SHA-256 of the release ZIP; the host refuses any other bytes. */
  bundleSha256: string
  /**
   * Bearer for `bundleUrl`, when the Store's backend requires one. The host
   * forwards it untouched and keeps no Store address of its own: entitlement is
   * settled between this miniapp and its backend, integrity by the SHA-256 and
   * the bundle's publisher signature.
   */
  bundleAuthorization?: string
  /**
   * Automatic update: never stop a running miniapp. A running or starting
   * target defers the request with `APP_RUNNING`.
   */
  onlyIfStopped?: boolean
  /**
   * With `onlyIfStopped`: when the target is running, the host stages the
   * release and asks the user whether to update now. Declining, or a prompt the
   * host does not show (the Mentra App is in the background, another prompt is
   * open, or this miniapp was asked within the last day), still answers
   * `APP_RUNNING`.
   */
  askIfRunning?: boolean
  /** Minimum Mentra App version declared by the release manifest. */
  minHostVersion?: string
  /** Mentra Miniapp SDK version declared by the release manifest. */
  sdkVersion?: string
  /** Glasses hardware requirements declared by the release manifest. */
  hardwareRequirements?: MiniappHardwareRequirement[]
  releaseId?: string
  channel?: string
}

export interface InstallMiniappResult {
  packageName: string
  version: string
  installedByStore: string
}

export interface InstallMiniappCompatibilityRequest {
  minHostVersion?: string | null
  sdkVersion?: string | null
  hardwareRequirements?: MiniappHardwareRequirement[]
}

export type InstallMiniappCompatibility =
  | {compatible: true}
  | {compatible: false; blocker: "host" | "sdk" | "hardware"; reason: string}

export type InstallMiniappPhase = "downloading" | "verifying" | "extracting" | "activating" | "complete"

export interface InstallMiniappProgress {
  packageName: string
  version: string
  phase: InstallMiniappPhase
}

export class MiniappsModule {
  private readonly progressHandlers = new Set<(progress: InstallMiniappProgress) => void>()

  constructor(private readonly session: MiniappSession) {}

  /**
   * List installed miniapps. Compatible-only by default; pass
   * `{includeIncompatible: true}` to include the rest (each carries a
   * `compatibility` result with the missing hardware). SYSTEM-only.
   */
  async list(opts?: ListMiniappsOptions): Promise<MiniappInfo[]> {
    const result = await this.session.sendRequest<MiniappInfo[]>({
      type: MiniappRequestType.MINIAPPS_LIST,
      includeIncompatible: opts?.includeIncompatible ?? false,
    })
    return result ?? []
  }

  /**
   * Start another miniapp in the **background** — spawns its background JS
   * context without changing the user's phone navigation or foregrounding
   * anything. The app reports as running and can handle actions / drive the
   * glasses immediately; its WebView only mounts if the user later opens it.
   * SYSTEM-only.
   */
  async start(packageName: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.MINIAPPS_START,
      packageName,
    })
  }

  /** Start another miniapp and foreground its phone UI. SYSTEM-only. */
  async open(packageName: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.MINIAPPS_START,
      packageName,
      foreground: true,
    })
  }

  /** Stop another miniapp. SYSTEM-only. */
  async stop(packageName: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.MINIAPPS_STOP,
      packageName,
    })
  }

  /**
   * Download, verify, and install a release through the phone host. Accepted
   * only from a Store bundled with the Mentra App build; other callers receive
   * NOT_PERMITTED.
   */
  async install(request: InstallMiniappRequest): Promise<InstallMiniappResult> {
    return this.session.sendRequest<InstallMiniappResult>(
      {
        ...request,
        type: MiniappRequestType.MINIAPPS_INSTALL,
      },
      // Downloading, validating, extracting, asking the user and relaunching
      // can legitimately outlast the SDK's default request timeout. The request
      // still settles on the host response or session disconnect.
      {timeoutMs: 0},
    )
  }

  /** Check host, Mentra Miniapp SDK, and glasses compatibility before offering or applying an update. */
  async checkInstallCompatibility(request: InstallMiniappCompatibilityRequest): Promise<InstallMiniappCompatibility> {
    return this.session.sendRequest<InstallMiniappCompatibility>({
      type: MiniappRequestType.MINIAPPS_INSTALL_CHECK,
      minHostVersion: request.minHostVersion ?? undefined,
      sdkVersion: request.sdkVersion ?? undefined,
      hardwareRequirements: request.hardwareRequirements ?? [],
    })
  }

  /** Subscribe to host-owned install progress. Returns an unsubscribe function. */
  onInstallProgress(handler: (progress: InstallMiniappProgress) => void): () => void {
    this.progressHandlers.add(handler)
    return () => this.progressHandlers.delete(handler)
  }

  /** @internal */
  _deliverInstallProgress(progress: InstallMiniappProgress): void {
    for (const handler of this.progressHandlers) handler(progress)
  }

  /** Uninstall a package this Store installed. Bundled Stores only. */
  async uninstall(packageName: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.MINIAPPS_UNINSTALL,
      packageName,
    })
  }
}
