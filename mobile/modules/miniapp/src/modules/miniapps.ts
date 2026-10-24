/**
 * @fileoverview MiniappsModule — `session.miniapps`.
 *
 * Discover and control the lifecycle of OTHER miniapps: list, start, open,
 * stop. SYSTEM-only — every call rejects with NOT_PERMITTED unless the caller
 * is a system app (Mentra AI is the first consumer). The action *capability*
 * layer (invoke / handle) lives on `session.actions`, not here — these are
 * operations on the app as a whole, not on a declared action.
 *
 * Installing (`install`, `checkInstallCompatibility`, `uninstall`) is
 * narrower still: only a miniapp on the Mentra App's system list, running the
 * release the Mentra App installed for it, may install miniapps. Development
 * builds, which may use the calls above, may not. The host installs from a
 * miniapp URL through the same installer as every other way in, with no install
 * sheet: the caller asks the person first.
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

/** A miniapp to install. */
export interface InstallMiniappRequest {
  /** The miniapp's URL: the HTTPS address that serves its `miniapp.json`. */
  url: string
}

export interface InstallMiniappResult {
  /**
   * `installed`: this release installed. `opened`: nothing installed, because the miniapp is installed from this URL
   * already, or a newer release of it is; {@link MiniappsModule.open} it to show it. `deferred`: the miniapp is
   * running, so its update waits until it stops, or until the person answers the Mentra App's update prompt.
   */
  status: "installed" | "opened" | "deferred"
  packageName: string
  /** The installed version: the new release, or the one that stays. */
  version: string
}

/**
 * Why an install failed: the `reason` of an `INSTALL_FAILED` rejection from {@link MiniappsModule.install}.
 * - `not_a_miniapp`: the URL serves no valid `miniapp.json` or bundle.
 * - `domain_mismatch`: the package name doesn't belong to the URL's domain.
 * - `archived`: Mentra archived this URL; it doesn't install.
 * - `needs_newer_app`: the miniapp needs a newer Mentra App, or hardware the glasses lack.
 * - `access_denied`: its server refused this account, or this deployment doesn't allow installing from a URL.
 * - `age_restricted`: the person's declared age is below the miniapp's age rating.
 * - `network`: the URL couldn't be reached.
 * - `cancelled`: the Mentra App signed out or switched deployments meanwhile.
 * - `integrity`: the bundle doesn't match what `miniapp.json` names.
 * - `signature_invalid`: the bundle's signature doesn't match the installed miniapp's publisher.
 */
export type InstallMiniappFailureReason =
  | "not_a_miniapp"
  | "domain_mismatch"
  | "archived"
  | "needs_newer_app"
  | "access_denied"
  | "age_restricted"
  | "network"
  | "cancelled"
  | "integrity"
  | "signature_invalid"

export interface InstallMiniappCompatibilityRequest {
  minHostVersion?: string | null
  sdkVersion?: string | null
  hardwareRequirements?: MiniappHardwareRequirement[]
}

export type InstallMiniappCompatibility =
  | {compatible: true}
  | {compatible: false; blocker: "host" | "sdk" | "hardware"; reason: string}

export class MiniappsModule {
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
   * Install the miniapp at a miniapp URL, with no install sheet: ask the person first. The host fetches its
   * `miniapp.json`, checks the package name against the URL's domain, registers the URL with Mentra, checks the
   * phone can run it, and downloads, verifies and installs its bundle.
   *
   * Only a miniapp on the Mentra App's system list may install; any other caller gets NOT_PERMITTED. A failed
   * install rejects with INSTALL_FAILED, whose `reason` is an {@link InstallMiniappFailureReason}.
   */
  async install(request: InstallMiniappRequest): Promise<InstallMiniappResult> {
    return this.session.sendRequest<InstallMiniappResult>(
      {type: MiniappRequestType.MINIAPPS_INSTALL, url: request.url},
      // Fetching, registering, downloading and installing can legitimately outlast the SDK's default request
      // timeout. The request still settles on the host response or session disconnect.
      {timeoutMs: 0},
    )
  }

  /** Check a release's Mentra App, SDK and glasses requirements against this phone. System-list miniapps only. */
  async checkInstallCompatibility(request: InstallMiniappCompatibilityRequest): Promise<InstallMiniappCompatibility> {
    return this.session.sendRequest<InstallMiniappCompatibility>({
      type: MiniappRequestType.MINIAPPS_INSTALL_CHECK,
      minHostVersion: request.minHostVersion ?? undefined,
      sdkVersion: request.sdkVersion ?? undefined,
      hardwareRequirements: request.hardwareRequirements ?? [],
    })
  }

  /**
   * Uninstall a miniapp installed from a miniapp URL. A miniapp the Mentra App bundles, one a workspace manages and a
   * development build stay, with NOT_PERMITTED. System-list miniapps only.
   */
  async uninstall(packageName: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.MINIAPPS_UNINSTALL,
      packageName,
    })
  }
}
