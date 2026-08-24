/**
 * @fileoverview MiniappsModule — `session.miniapps`.
 *
 * Discover and control the lifecycle of OTHER miniapps: list, start, stop.
 * SYSTEM-only — every call rejects with NOT_PERMITTED unless the caller is a
 * system app (Mentra AI is the first consumer). The action *capability* layer
 * (invoke / handle) lives on `session.actions`, not here — these three are
 * operations on the app as a whole, not on a declared action.
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
  /** True when this package identity is backed by a ZIP in the host build. */
  system: boolean
  /** Store package that owns this active release, if it was Store-installed. */
  storeOwnerPackageName?: string
  /** Declared actions (empty if the miniapp declares none). */
  actions: MiniappActionInfo[]
}

export interface ListMiniappsOptions {
  /** Include incompatible miniapps too (default false — compatible-only). */
  includeIncompatible?: boolean
}

/** Backend-neutral bundle request accepted only from a host-trusted SYSTEM Store. */
export interface InstallMiniappRequest {
  packageName: string
  version: string
  bundleUrl: string
  bundleSha256: string
  /** Minimum Mentra App/host version declared by the release manifest. */
  minHostVersion?: string
  /** Mentra Miniapp SDK ABI version declared by the release manifest. */
  sdkVersion?: string
  releaseId?: string
  channel?: string
  /**
   * Reserved signed-descriptor envelope for federated/OEM Stores. Current
   * hosts use the SYSTEM caller + package/version/hash MVP while preserving
   * the wire shape needed for issuer and publisher verification later.
   */
  authorization?: MiniappInstallAuthorization
}

export interface MiniappInstallAuthorization {
  schemaVersion: 1
  manifestSha256: string
  publisherKeyId: string
  publisherSignature: string
  storeIssuer: string
  issuedAt: string
  expiresAt: string
  storeAuthorization: string
}

export interface InstallMiniappResult {
  packageName: string
  version: string
  installedByStore: string
}

export interface InstallMiniappCompatibilityRequest {
  minHostVersion?: string | null
  sdkVersion?: string | null
}

export type InstallMiniappCompatibility = {compatible: true} | {compatible: false; reason: string}

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

  /**
   * Start another miniapp and foreground its phone UI. SYSTEM-only.
   * Store miniapps should use this for an installed app's Open action.
   */
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
   * Download, verify, and install a Store release through the phone host.
   * SYSTEM-only; ordinary miniapps receive NOT_PERMITTED.
   */
  async install(request: InstallMiniappRequest): Promise<InstallMiniappResult> {
    return this.session.sendRequest<InstallMiniappResult>(
      {
        ...request,
        type: MiniappRequestType.MINIAPPS_INSTALL,
      },
      // Downloading, validating, extracting, and launching a bundle can
      // legitimately take longer than the SDK's default request timeout.
      // The request still settles on the host response or session disconnect.
      {timeoutMs: 0},
    )
  }

  /** Check host and Mentra Miniapp SDK compatibility before offering or automatically applying an update. */
  async checkInstallCompatibility(request: InstallMiniappCompatibilityRequest): Promise<InstallMiniappCompatibility> {
    return this.session.sendRequest<InstallMiniappCompatibility>({
      type: MiniappRequestType.MINIAPPS_INSTALL_CHECK,
      minHostVersion: request.minHostVersion ?? undefined,
      sdkVersion: request.sdkVersion ?? undefined,
    })
  }

  /** Subscribe to host-owned install/update progress. Returns an unsubscribe function. */
  onInstallProgress(handler: (progress: InstallMiniappProgress) => void): () => void {
    this.progressHandlers.add(handler)
    return () => this.progressHandlers.delete(handler)
  }

  /** @internal */
  _deliverInstallProgress(progress: InstallMiniappProgress): void {
    for (const handler of this.progressHandlers) handler(progress)
  }

  /** Uninstall a package managed by this Store. SYSTEM-only. */
  async uninstall(packageName: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.MINIAPPS_UNINSTALL,
      packageName,
    })
  }
}
