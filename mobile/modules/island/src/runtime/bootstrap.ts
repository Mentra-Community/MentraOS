/**
 * Bootstrap — island's single front door (`island.configure` / `start` / `stop`).
 *
 * The Phase-1 contract's end state is: the host hands island its auth + config in
 * ONE call and island owns the rest. This is the additive first step of that: a
 * config holder the host populates, plus the lifecycle verbs. It lives ALONGSIDE
 * the three transitional config seams (`configureRuntime` / `configureLauncher` /
 * `configureIsland`) — those still carry the host adapters during the migration
 * and collapse into this front door only as each domain lands in island.
 *
 * So today `configure()` stores auth/config/analytics for island to read, and
 * `start()`/`stop()` mark the lifecycle; the host's existing boot is unchanged.
 * Future domain PRs route their consumers through `getAuth()` / `getConfigValues()`
 * / `getAnalytics()` and retire the matching adapter.
 */

export type SubjectTokenType = "supabase" | "authing" | (string & {})

export interface IslandAuth {
  /** Returns the host's current (auto-refreshed) subject token for the backend. */
  getSubjectToken: () => Promise<{token: string; type: SubjectTokenType}>
}

export interface IslandConfigValues {
  /** cloud-v2 core service base URL (defaults resolved by the cloud client). */
  coreUrl?: string
  /** cloud-v2 runtime service base URL. */
  runtimeUrl?: string
  /** OEM identifier (Mentra is OEM #0); reserved for OEM auth/telemetry. */
  oemId?: string
}

export type IslandAnalytics = (event: string, props?: Record<string, unknown>) => void

export interface IslandConfigureOptions {
  /** REQUIRED — the only must-have seam. The host owns login; island owns the rest. */
  auth: IslandAuth
  config?: IslandConfigValues
  analytics?: IslandAnalytics
}

let options: IslandConfigureOptions | null = null
let started = false

/** Hand island its auth + config + analytics. Call once, before `start()`. */
export function configure(opts: IslandConfigureOptions): void {
  options = opts
}

/** Mark the runtime started. Idempotent. */
export async function start(): Promise<void> {
  if (started) return
  if (!options) {
    throw new Error("island.start() called before island.configure()")
  }
  started = true
}

/** Tear down. Idempotent. */
export async function stop(): Promise<void> {
  started = false
}

export function isStarted(): boolean {
  return started
}

/** The host-supplied auth provider, or null if not configured yet. */
export function getAuth(): IslandAuth | null {
  return options?.auth ?? null
}

export function getConfigValues(): IslandConfigValues {
  return options?.config ?? {}
}

export function getAnalytics(): IslandAnalytics | null {
  return options?.analytics ?? null
}
