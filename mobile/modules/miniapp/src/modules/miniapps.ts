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
  /** Declared actions (empty if the miniapp declares none). */
  actions: MiniappActionInfo[]
}

export interface ListMiniappsOptions {
  /** Include incompatible miniapps too (default false — compatible-only). */
  includeIncompatible?: boolean
}

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

  /** Stop another miniapp. SYSTEM-only. */
  async stop(packageName: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.MINIAPPS_STOP,
      packageName,
    })
  }
}
