/**
 * The Fleet assignment reconciler: makes this phone's assigned miniapps match the account's desired state.
 *
 * - Desired state is read through an injected {@link DesiredStateClient}. Only a complete, schema-valid answer whose
 *   revision is not older than the one applied changes anything. An error, timeout, partial answer, 503 or unknown
 *   status changes nothing: the last complete snapshot stands and the fetch retries with backoff.
 * - Triggers (startup, foreground, a newer ack revision, a stop, reconnect, leaving a workspace) coalesce into one
 *   fetch after a short jitter. An ack revision that is not newer than the applied one fetches nothing.
 * - `managed`: each entry's URL decides the version. A missing or older package installs through the one release
 *   installer (a first install is silent; a running miniapp's update waits or asks). A satisfied assignment never
 *   reinstalls, unless the URL serves different bytes under the same version. Entries no longer desired lose their
 *   `assignment` reason; a package left with no reason uninstalls once it is idle. Its data stays.
 * - `unmanaged`: every assignment reason this account holds is withdrawn the same way.
 * - The URL's server decides access. `access_denied` blocks the package's launch and stops it now (an update may
 *   wait for a stop; a revocation never does). `archived` and `not_a_miniapp` are reported and withdraw nothing.
 * - A context (Core, account, workspace) change invalidates every operation of the old context before the new one
 *   activates: nothing downloaded for the old context commits. No lock is persisted, so a kill leaves none.
 * - Each assignment's state change is one `assignment_outcome` (validated against the protocol schema).
 *
 * Pure: every effect goes through {@link AssignmentReconcilerDeps}. The host wiring is `assignmentReconcilerHost.ts`.
 */
import {
  FleetAssignmentOutcomePayloadSchema,
  FleetDesiredStateSchema,
  type FleetAssignmentOutcomePayload,
  type FleetAssignmentReason,
  type FleetAssignmentState,
  type FleetDesiredState,
  type FleetDesiredStateEntry,
} from "@mentra/cloud-protocol"
import semver from "semver"

import {normalizeCoreUrl} from "./coreUrl"
import type {FleetManagementState} from "./fleetManagementState"
import type {FleetKeyValueStore} from "./fleetQueue"

/** Reads the signed-in account's desired state (`GET /api/client/fleet/desired-state` through Core). Throws on any failure. */
export interface DesiredStateClient {
  fetch(): Promise<FleetDesiredState>
}

export interface ReconcilerSession {
  coreUrl: string
  mentraUserId: string
}

/** What a miniapp URL serves now (its `miniapp.json` names the ZIP and its SHA-256), or why it cannot be installed. */
export type ManagedResolution =
  | {ok: true; packageName: string; version: string; bundleUrl: string; bundleSha256: string}
  | {ok: false; reason: FleetAssignmentReason}

/** The assignment a managed install commits with its bundle. */
export interface ManagedAssignment {
  assignmentId: string
  assignmentRevision: number
  workspaceId: string
  coreUrl: string
  mentraUserId: string
  url: string
}

/** Why an install did not commit: a reason, `running` (it waits for a stop) or `cancelled` (its context ended). */
export type ManagedInstallFailure = FleetAssignmentReason | "running" | "cancelled"

/** The phone's miniapps, as the reconciler uses them. */
export interface ManagedMiniappPort {
  resolve(url: string): Promise<ManagedResolution>
  /** The active installed release, or null when the package is not installed. */
  installedRelease(packageName: string): Promise<{version: string; bundleSha256?: string} | null>
  /** True when the package holds any reason besides `assignment` (explicit, bundled, manifest). */
  hasOtherReason(packageName: string): boolean
  /** The assignment the package's install recorded, or null. */
  assignment(packageName: string): ManagedAssignment | null
  /** Every package holding an `assignment` reason, whichever account's. */
  assignedPackages(): string[]
  /** A live-development build or snapshot is selected for the package, so launching would not run the release. */
  hasDevelopmentSelection(packageName: string): boolean
  /** Clear the package's live-development selection, so launching runs its installed release. */
  clearDevelopmentSelection(packageName: string): Promise<void>
  install(request: {
    resolution: Extract<ManagedResolution, {ok: true}>
    assignment: ManagedAssignment
    isCancelled: () => boolean
    /** Called when the install stops to wait for the person's answer to its update prompt. */
    onAsking?: () => void
  }): Promise<void>
  /** Map an install error to its failure. */
  classify(error: unknown): {kind: ManagedInstallFailure; retryable: boolean}
  /** Record the assignment on a package that already satisfies it. */
  setAssignment(packageName: string, assignment: ManagedAssignment): void
  /** Remove the `assignment` reason. */
  clearAssignment(packageName: string): void
  uninstall(packageName: string): Promise<void>
  /** Running as user activity, or with a context registered. */
  isRunning(packageName: string): boolean
  /** Calls `listener` with each package that stops. Returns the unsubscribe function. */
  onStopped(listener: (packageName: string) => void): () => void
  /** Calls `listener` with each running package opened again after its update prompt's Not now. */
  onUpdateDue(listener: (packageName: string) => void): () => void
  /** Block launch and stop the package now. Uninstalls nothing. */
  revokeAccess(packageName: string): Promise<void>
  restoreAccess(packageName: string): void
  isAccessRevoked(packageName: string): boolean
  /** Answer the package's open update prompt as not shown, so its install stops waiting and defers. */
  dismissUpdatePrompt(packageName: string): void
  /** The data and development context for this account: the workspace it belongs to, or none. */
  setWorkspaceContext(session: ReconcilerSession, workspaceId: string | null): void
}

export interface ReconcilerTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface AssignmentReconcilerDeps {
  client: DesiredStateClient
  miniapps: ManagedMiniappPort
  /** The signed-in account on its Core, or null. */
  getSession(): ReconcilerSession | null
  /** False while the phone has no network: nothing is fetched or installed until reconnect. */
  isOnline(): boolean
  store: FleetKeyValueStore
  emit(outcome: FleetAssignmentOutcomePayload): void
  /** The account's last complete answer, published on each session change and each answer applied. */
  onManagementState?(state: FleetManagementState): void
  timers: ReconcilerTimers
  now?: () => number
  random?: () => number
}

export type ReconcileTrigger =
  | "startup"
  | "foreground"
  | "revision"
  | "stopped"
  | "opened"
  | "reconnect"
  | "leave"
  | "retry"
  | "refresh"

export interface AssignmentReconciler {
  /** Ask for a reconcile. `revision` is the ack revision for `revision` triggers. */
  trigger(kind: ReconcileTrigger, revision?: number): void
  /** The account, Core or workspace context changed: invalidate everything in flight. */
  sessionChanged(): void
  stop(): void
}

export const RECONCILER_STORE_PREFIX = "fleet.assignments.v1/"
export const FETCH_TIMEOUT_MS = 30_000
export const TRIGGER_JITTER_MS = 2_000
export const RETRY_BASE_MS = 5_000
export const RETRY_MAX_MS = 15 * 60_000

interface StoredOutcome {
  packageName: string
  assignmentRevision: number
  state: FleetAssignmentState
  reason?: FleetAssignmentReason
  selectedVersion?: string
  installedVersion?: string
  attempts: number
  attemptedAt: string
  lastSuccessAt?: string
}

interface PersistedState {
  appliedRevision: number
  /** The last complete snapshot. */
  snapshot: FleetDesiredState | null
  /** By assignment id: what this phone last reported. Also the record of what this account assigned here. */
  outcomes: Record<string, StoredOutcome>
  /** Packages whose last reason was withdrawn while they ran: uninstall once idle. */
  pendingUninstalls: string[]
  /** Packages this account's access check revoked. Blocked only while this account is signed in. */
  revoked: string[]
}

class Superseded extends Error {}

/** An install waiting for the person's answer to its update prompt. The cycle goes on without it. */
interface AskingInstall {
  assignmentId: string
  assignmentRevision: number
  selectedVersion: string
  gen: number
  /** The ack revision whose desired state still wants this install; a newer one cancels it unless it still does. */
  heard: {revision: number}
  /** Resolves once the install committed or failed. Never rejects. */
  settled: Promise<void>
}

function emptyState(): PersistedState {
  return {appliedRevision: 0, snapshot: null, outcomes: {}, pendingUninstalls: [], revoked: []}
}

function sessionKey(session: ReconcilerSession): string {
  return `${RECONCILER_STORE_PREFIX}${normalizeCoreUrl(session.coreUrl)}|${session.mentraUserId}`
}

function workspaceOf(snapshot: FleetDesiredState | null): string | null {
  return snapshot?.status === "managed" ? snapshot.workspace.workspaceId : null
}

function sameSession(a: ReconcilerSession | null, b: ReconcilerSession | null): boolean {
  if (!a || !b) return a === b
  return a.mentraUserId === b.mentraUserId && normalizeCoreUrl(a.coreUrl) === normalizeCoreUrl(b.coreUrl)
}

function versionOrder(a: string, b: string): number {
  const ca = semver.valid(semver.coerce(a) ?? a)
  const cb = semver.valid(semver.coerce(b) ?? b)
  if (!ca || !cb) return a === b ? 0 : NaN
  return semver.compare(ca, cb)
}

export function createAssignmentReconciler(deps: AssignmentReconcilerDeps): AssignmentReconciler {
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const {miniapps} = deps

  /** Bumped whenever the context changes. Work started under an older generation never commits. */
  let generation = 0
  let session: ReconcilerSession | null = null
  let state = emptyState()
  /** The highest ack revision heard for this session. */
  let wantedRevision = 0
  let timer: unknown = null
  let timerDue = Infinity
  let cycle: Promise<void> | null = null
  let again = false
  let failures = 0
  let stopped = false
  const asking = new Map<string, AskingInstall>()
  const stopListener = miniapps.onStopped((packageName) => onPackageStopped(packageName))
  const dueListener = miniapps.onUpdateDue((packageName) => {
    if (!stopped && session && isWaiting(packageName)) trigger("opened")
  })

  function iso(at = now()): string {
    return new Date(at).toISOString()
  }

  function load(s: ReconcilerSession): PersistedState {
    const raw = deps.store.getString(sessionKey(s))
    if (!raw) return emptyState()
    try {
      const parsed = JSON.parse(raw) as PersistedState
      const snapshot = parsed.snapshot ? FleetDesiredStateSchema.safeParse(parsed.snapshot) : null
      return {
        appliedRevision: Number.isInteger(parsed.appliedRevision) ? parsed.appliedRevision : 0,
        snapshot: snapshot?.success ? snapshot.data : null,
        outcomes: parsed.outcomes && typeof parsed.outcomes === "object" ? parsed.outcomes : {},
        pendingUninstalls: Array.isArray(parsed.pendingUninstalls) ? parsed.pendingUninstalls : [],
        revoked: Array.isArray(parsed.revoked) ? parsed.revoked : [],
      }
    } catch {
      return emptyState()
    }
  }

  function save(): void {
    if (session) deps.store.set(sessionKey(session), JSON.stringify(state))
  }

  /** Follow the engine's session; a different one starts a new generation with its own persisted state. */
  function syncSession(): boolean {
    const current = deps.getSession()
    if (sameSession(current, session)) return current !== null
    supersede()
    session = current
    state = current ? load(current) : emptyState()
    wantedRevision = 0
    failures = 0
    again = false
    // Signed out, the last account's revocations stand. Another account sees only its own.
    if (current) applyRevocations(sessionKey(current))
    publishManagement()
    return current !== null
  }

  function publishManagement(): void {
    const snapshot = session ? state.snapshot : null
    deps.onManagementState?.(
      snapshot?.status === "managed"
        ? {status: "managed", workspaceId: snapshot.workspace.workspaceId, workspaceName: snapshot.workspace.name}
        : snapshot?.status === "unmanaged"
          ? {status: "unmanaged"}
          : {status: "unknown"},
    )
  }

  function applyRevocations(key: string): void {
    const mine = new Set(state.revoked)
    for (const other of deps.store.getAllKeys()) {
      if (other === key || !other.startsWith(RECONCILER_STORE_PREFIX)) continue
      let revoked: unknown
      try {
        revoked = (JSON.parse(deps.store.getString(other) ?? "{}") as Partial<PersistedState>).revoked
      } catch {
        continue
      }
      if (!Array.isArray(revoked)) continue
      for (const packageName of revoked) {
        if (typeof packageName === "string" && !mine.has(packageName) && miniapps.isAccessRevoked(packageName))
          miniapps.restoreAccess(packageName)
      }
    }
    for (const packageName of mine) {
      if (!miniapps.isAccessRevoked(packageName)) void miniapps.revokeAccess(packageName).catch(() => {})
    }
  }

  function assertCurrent(gen: number): void {
    if (stopped || gen !== generation) throw new Superseded()
  }

  /** Start a new generation: nothing in flight commits, and no prompt of the old one waits for an answer. */
  function supersede(): void {
    generation += 1
    for (const packageName of asking.keys()) miniapps.dismissUpdatePrompt(packageName)
  }

  /** Stop waiting for the package's prompt, if one is open, and let its install settle. */
  async function dismissAsking(packageName: string): Promise<void> {
    const pending = asking.get(packageName)
    if (!pending) return
    miniapps.dismissUpdatePrompt(packageName)
    await pending.settled
  }

  // --- scheduling ----------------------------------------------------------------------------------------------

  function schedule(delayMs: number): void {
    if (stopped) return
    const due = now() + delayMs
    if (timer !== null && timerDue <= due) return
    if (timer !== null) deps.timers.clearTimeout(timer)
    timerDue = due
    timer = deps.timers.setTimeout(() => {
      timer = null
      timerDue = Infinity
      run()
    }, delayMs)
  }

  function jitter(): number {
    return Math.floor(random() * TRIGGER_JITTER_MS)
  }

  function backoff(): number {
    const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures, 20))
    failures += 1
    return Math.floor(base * (0.5 + random() * 0.5))
  }

  function run(): void {
    if (cycle) {
      again = true
      return
    }
    cycle = reconcileOnce()
      .catch((error) => {
        if (!(error instanceof Superseded)) console.warn("Fleet assignment reconcile failed", error)
      })
      .finally(() => {
        cycle = null
        if (again && !stopped) {
          again = false
          schedule(jitter())
        }
      })
  }

  // --- one cycle -----------------------------------------------------------------------------------------------

  async function reconcileOnce(): Promise<void> {
    if (!syncSession()) return
    if (!deps.isOnline()) return
    const gen = generation
    let fetched: FleetDesiredState | null = null
    try {
      fetched = await fetchWithTimeout()
    } catch {
      fetched = null
    }
    assertCurrent(gen)
    const parsed = fetched === null ? null : FleetDesiredStateSchema.safeParse(fetched)
    if (!parsed?.success) {
      schedule(backoff())
      return
    }
    const desired = parsed.data
    // A stale replica answers an older revision: keep what was applied.
    if (desired.revision < state.appliedRevision) {
      schedule(backoff())
      return
    }
    failures = 0
    await apply(desired, gen)
    // The ack said a newer revision exists than the one served: read again later.
    if (wantedRevision > state.appliedRevision) schedule(backoff())
  }

  function fetchWithTimeout(): Promise<FleetDesiredState> {
    return new Promise((resolve, reject) => {
      const handle = deps.timers.setTimeout(() => reject(new Error("desired state timed out")), FETCH_TIMEOUT_MS)
      deps.client.fetch().then(
        (value) => {
          deps.timers.clearTimeout(handle)
          resolve(value)
        },
        (error: unknown) => {
          deps.timers.clearTimeout(handle)
          reject(error)
        },
      )
    })
  }

  async function apply(desired: FleetDesiredState, gen: number): Promise<void> {
    const current = session!
    const previousWorkspace = workspaceOf(state.snapshot)
    const workspace = workspaceOf(desired)
    if (previousWorkspace !== workspace || state.snapshot === null) {
      // Leaving one context: nothing of the old one may commit once the new one is active.
      if (previousWorkspace !== workspace && state.snapshot !== null) supersede()
      gen = generation
      miniapps.setWorkspaceContext(current, workspace)
    }
    state.appliedRevision = desired.revision
    state.snapshot = desired
    save()
    publishManagement()

    const entries = desired.status === "managed" ? desired.entries : []
    const byPackage = new Map<string, FleetDesiredStateEntry>()
    const duplicates: FleetDesiredStateEntry[] = []
    for (const entry of entries) {
      if (byPackage.has(entry.packageName)) duplicates.push(entry)
      else byPackage.set(entry.packageName, entry)
    }

    await withdrawUndesired(byPackage, desired.revision, gen)
    for (const entry of duplicates) {
      record(entry, desired.revision, {state: "blocked", reason: "manifest_conflict"})
    }
    for (const entry of byPackage.values()) {
      assertCurrent(gen)
      await reconcileEntry(entry, desired, gen)
    }
  }

  async function withdrawUndesired(
    byPackage: Map<string, FleetDesiredStateEntry>,
    desiredRevision: number,
    gen: number,
  ): Promise<void> {
    const desiredIds = new Set([...byPackage.values()].map((entry) => entry.assignmentId))
    for (const packageName of [...asking.keys()]) {
      if (!byPackage.has(packageName)) await dismissAsking(packageName)
    }
    assertCurrent(gen)
    for (const [assignmentId, outcome] of Object.entries(state.outcomes)) {
      if (desiredIds.has(assignmentId)) continue
      assertCurrent(gen)
      const stillDesired = byPackage.has(outcome.packageName)
      if (!stillDesired) {
        const recorded = miniapps.assignment(outcome.packageName)
        if (recorded && recorded.assignmentId === assignmentId) miniapps.clearAssignment(outcome.packageName)
        if (outcome.state === "installed" || outcome.state === "deferred_running" || recorded) {
          if (!miniapps.hasOtherReason(outcome.packageName) && !state.pendingUninstalls.includes(outcome.packageName))
            state.pendingUninstalls.push(outcome.packageName)
        }
      }
      emitOutcome(assignmentId, {...outcome, state: "withdrawn", reason: undefined}, desiredRevision)
      delete state.outcomes[assignmentId]
      save()
    }
    // An assignment reason this account has no outcome for, such as one a previous account's assignment recorded,
    // stays only while this account's complete desired state still names the package.
    for (const packageName of miniapps.assignedPackages()) {
      if (byPackage.has(packageName)) continue
      assertCurrent(gen)
      miniapps.clearAssignment(packageName)
      if (!miniapps.hasOtherReason(packageName) && !state.pendingUninstalls.includes(packageName)) {
        state.pendingUninstalls.push(packageName)
        save()
      }
    }
    await uninstallIdle(gen)
  }

  /** Uninstall each withdrawn package that is idle and still holds no other reason. A running one waits for its stop. */
  async function uninstallIdle(gen: number): Promise<void> {
    for (const packageName of [...state.pendingUninstalls]) {
      assertCurrent(gen)
      const desired =
        state.snapshot?.status === "managed" && state.snapshot.entries.some((e) => e.packageName === packageName)
      if (desired || miniapps.hasOtherReason(packageName) || miniapps.assignment(packageName)) {
        dropPending(packageName)
        continue
      }
      if (miniapps.isRunning(packageName)) continue
      try {
        await miniapps.uninstall(packageName)
        dropPending(packageName)
      } catch (error) {
        console.warn(`Fleet could not uninstall withdrawn ${packageName}`, error)
      }
    }
  }

  function dropPending(packageName: string): void {
    state.pendingUninstalls = state.pendingUninstalls.filter((name) => name !== packageName)
    save()
  }

  async function reconcileEntry(entry: FleetDesiredStateEntry, desired: FleetDesiredState, gen: number): Promise<void> {
    const current = session!
    const workspaceId = workspaceOf(desired)!
    const previous = state.outcomes[entry.assignmentId]
    if (!deps.isOnline()) {
      if (!previous) record(entry, desired.revision, {state: "pending"})
      return
    }

    const resolution = await miniapps.resolve(entry.url)
    assertCurrent(gen)
    if (!resolution.ok) {
      if (resolution.reason === "access_denied") {
        const installed = await miniapps.installedRelease(entry.packageName)
        assertCurrent(gen)
        if (installed && !state.revoked.includes(entry.packageName)) {
          state.revoked.push(entry.packageName)
          save()
          await miniapps.revokeAccess(entry.packageName)
        }
      }
      if (resolution.reason === "download_failed") {
        record(entry, desired.revision, {state: "retrying", reason: "download_failed"})
        schedule(backoff())
      } else {
        record(entry, desired.revision, {state: "blocked", reason: resolution.reason})
      }
      return
    }
    if (state.revoked.includes(entry.packageName)) {
      state.revoked = state.revoked.filter((name) => name !== entry.packageName)
      save()
      miniapps.restoreAccess(entry.packageName)
    }
    if (resolution.packageName !== entry.packageName) {
      record(entry, desired.revision, {
        state: "blocked",
        reason: "manifest_conflict",
        selectedVersion: resolution.version,
      })
      return
    }

    const assignment: ManagedAssignment = {
      assignmentId: entry.assignmentId,
      assignmentRevision: entry.revision,
      workspaceId,
      coreUrl: current.coreUrl,
      mentraUserId: current.mentraUserId,
      url: entry.url,
    }
    const selectedVersion = resolution.version
    const waiting = asking.get(entry.packageName)
    if (waiting) {
      if (
        waiting.gen === gen &&
        waiting.assignmentId === entry.assignmentId &&
        waiting.assignmentRevision === entry.revision &&
        waiting.selectedVersion === selectedVersion
      ) {
        // Still the install this desired state wants: it keeps waiting for its answer.
        waiting.heard.revision = wantedRevision
        return
      }
      await dismissAsking(entry.packageName)
      assertCurrent(gen)
    }
    const installed = await miniapps.installedRelease(entry.packageName)
    assertCurrent(gen)
    // An install this release already refused is not downloaded again until the URL serves another version or the
    // assignment changes.
    if (
      previous?.state === "blocked" &&
      previous.assignmentRevision === entry.revision &&
      previous.selectedVersion === selectedVersion &&
      previous.attempts > 0 &&
      (previous.reason === "signature_invalid" ||
        previous.reason === "not_a_miniapp" ||
        previous.reason === "incompatible_host")
    ) {
      return
    }
    if (installed) {
      const order = versionOrder(installed.version, selectedVersion)
      if (order > 0) {
        record(entry, desired.revision, {
          state: "blocked",
          reason: "newer_version_installed",
          selectedVersion,
          installedVersion: installed.version,
        })
        return
      }
      // A release installed before digests were recorded counts as the served bytes at the same version.
      const sameBytes = !installed.bundleSha256 || resolution.bundleSha256 === installed.bundleSha256
      if (order === 0 && sameBytes) {
        // The cached release satisfies the assignment only once a live-development selection no longer runs instead.
        if (miniapps.hasDevelopmentSelection(entry.packageName)) {
          if (miniapps.isRunning(entry.packageName)) {
            record(entry, desired.revision, {
              state: "deferred_running",
              selectedVersion,
              installedVersion: installed.version,
            })
            return
          }
          await miniapps.clearDevelopmentSelection(entry.packageName)
          assertCurrent(gen)
        }
        const recorded = miniapps.assignment(entry.packageName)
        if (
          !recorded ||
          recorded.assignmentId !== assignment.assignmentId ||
          recorded.assignmentRevision !== assignment.assignmentRevision ||
          recorded.workspaceId !== assignment.workspaceId ||
          recorded.coreUrl !== assignment.coreUrl ||
          recorded.mentraUserId !== assignment.mentraUserId ||
          recorded.url !== assignment.url
        ) {
          miniapps.setAssignment(entry.packageName, assignment)
        }
        state.pendingUninstalls = state.pendingUninstalls.filter((name) => name !== entry.packageName)
        record(entry, desired.revision, {
          state: "installed",
          selectedVersion,
          installedVersion: installed.version,
          success: previous?.state !== "installed",
        })
        return
      }
    }

    const attempts = (previous && previous.assignmentRevision === entry.revision ? previous.attempts : 0) + 1
    record(entry, desired.revision, {
      state: "downloading",
      selectedVersion,
      installedVersion: installed?.version,
      attempts,
      attempted: true,
    })
    // A newer desired-state revision heard before the commit makes this decision stale; the next cycle reads it.
    const heard = {revision: wantedRevision}
    let markAsking!: () => void
    const asked = new Promise<null>((resolve) => {
      markAsking = () => resolve(null)
    })
    const finished = miniapps
      .install({
        resolution,
        assignment,
        isCancelled: () => stopped || gen !== generation || wantedRevision > heard.revision,
        onAsking: () => markAsking(),
      })
      .then(
        () => ({error: undefined as unknown, failed: false}),
        (error: unknown) => ({error, failed: true}),
      )
    const first = await Promise.race([finished, asked])
    if (first) {
      await settleInstall(entry, desired.revision, gen, selectedVersion, installed?.version, attempts, first)
      return
    }
    // The person is asked whether to close the running miniapp. Other assignments and later triggers go on; a
    // later cycle that wants something else dismisses the prompt.
    const pending: AskingInstall = {
      assignmentId: entry.assignmentId,
      assignmentRevision: entry.revision,
      selectedVersion,
      gen,
      heard,
      settled: finished.then(async (result) => {
        if (asking.get(entry.packageName) === pending) asking.delete(entry.packageName)
        try {
          await settleInstall(entry, state.appliedRevision, gen, selectedVersion, installed?.version, attempts, result)
        } catch (error) {
          if (!(error instanceof Superseded)) console.warn(`Fleet install of ${entry.packageName} failed`, error)
        }
      }),
    }
    asking.set(entry.packageName, pending)
    record(entry, desired.revision, {
      state: "deferred_running",
      selectedVersion,
      installedVersion: installed?.version,
      attempts,
    })
  }

  async function settleInstall(
    entry: FleetDesiredStateEntry,
    desiredRevision: number,
    gen: number,
    selectedVersion: string,
    installedVersion: string | undefined,
    attempts: number,
    result: {error: unknown; failed: boolean},
  ): Promise<void> {
    assertCurrent(gen)
    if (result.failed) {
      const {kind, retryable} = miniapps.classify(result.error)
      if (kind === "cancelled") throw new Superseded()
      const after = (await miniapps.installedRelease(entry.packageName))?.version ?? installedVersion
      assertCurrent(gen)
      if (kind === "running") {
        record(entry, desiredRevision, {state: "deferred_running", selectedVersion, installedVersion: after, attempts})
        return
      }
      record(entry, desiredRevision, {
        state: retryable ? "retrying" : "blocked",
        reason: kind,
        selectedVersion,
        installedVersion: after,
        attempts,
      })
      if (retryable) schedule(backoff())
      return
    }
    state.pendingUninstalls = state.pendingUninstalls.filter((name) => name !== entry.packageName)
    record(entry, desiredRevision, {
      state: "installed",
      selectedVersion,
      installedVersion: selectedVersion,
      attempts,
      success: true,
    })
  }

  // --- outcomes ------------------------------------------------------------------------------------------------

  function record(
    entry: FleetDesiredStateEntry,
    desiredRevision: number,
    next: {
      state: FleetAssignmentState
      reason?: FleetAssignmentReason
      selectedVersion?: string
      installedVersion?: string
      attempts?: number
      attempted?: boolean
      success?: boolean
    },
  ): void {
    const previous = state.outcomes[entry.assignmentId]
    const sameRevision = previous?.assignmentRevision === entry.revision
    const at = iso()
    const outcome: StoredOutcome = {
      packageName: entry.packageName,
      assignmentRevision: entry.revision,
      state: next.state,
      ...(next.reason ? {reason: next.reason} : {}),
      ...(next.selectedVersion ? {selectedVersion: next.selectedVersion} : {}),
      ...(next.installedVersion ? {installedVersion: next.installedVersion} : {}),
      attempts: next.attempts ?? (sameRevision ? previous!.attempts : 0),
      attemptedAt: next.attempted || !previous ? at : previous.attemptedAt,
      ...(next.success ? {lastSuccessAt: at} : previous?.lastSuccessAt ? {lastSuccessAt: previous.lastSuccessAt} : {}),
    }
    const changed =
      !previous ||
      !sameRevision ||
      previous.state !== outcome.state ||
      previous.reason !== outcome.reason ||
      previous.selectedVersion !== outcome.selectedVersion ||
      previous.installedVersion !== outcome.installedVersion
    state.outcomes[entry.assignmentId] = outcome
    save()
    if (changed) emitOutcome(entry.assignmentId, outcome, desiredRevision)
  }

  function emitOutcome(assignmentId: string, outcome: StoredOutcome, desiredRevision: number): void {
    const payload = {
      assignmentId,
      assignmentRevision: outcome.assignmentRevision,
      desiredRevision,
      packageName: outcome.packageName,
      state: outcome.state,
      ...(outcome.reason ? {reason: outcome.reason} : {}),
      ...(outcome.selectedVersion ? {selectedVersion: outcome.selectedVersion} : {}),
      ...(outcome.installedVersion ? {installedVersion: outcome.installedVersion} : {}),
      attempts: outcome.attempts,
      attemptedAt: outcome.attemptedAt,
      ...(outcome.lastSuccessAt ? {lastSuccessAt: outcome.lastSuccessAt} : {}),
    }
    const valid = FleetAssignmentOutcomePayloadSchema.safeParse(payload)
    if (!valid.success) {
      console.warn("Fleet assignment outcome is not valid; not reported", valid.error.issues[0]?.message)
      return
    }
    try {
      deps.emit(valid.data)
    } catch {
      // The reporter's failure never stops reconciling.
    }
  }

  // --- stops ---------------------------------------------------------------------------------------------------

  function onPackageStopped(packageName: string): void {
    if (stopped || !session) return
    if (state.pendingUninstalls.includes(packageName)) {
      const gen = generation
      void uninstallIdle(gen).catch(() => {})
    }
    if (isWaiting(packageName)) trigger("stopped")
  }

  function isWaiting(packageName: string): boolean {
    return Object.values(state.outcomes).some(
      (outcome) => outcome.packageName === packageName && outcome.state === "deferred_running",
    )
  }

  function trigger(kind: ReconcileTrigger, revision?: number): void {
    if (stopped) return
    syncSession()
    if (kind === "revision") {
      if (revision === undefined || !Number.isInteger(revision)) return
      if (revision <= state.appliedRevision || revision <= wantedRevision) return
      wantedRevision = revision
    }
    if (kind === "leave") {
      // The old workspace's work stops now; the new context activates when its desired state arrives.
      supersede()
      again = false
      schedule(0)
      return
    }
    if (kind === "retry") {
      schedule(backoff())
      return
    }
    if (cycle) {
      again = true
      return
    }
    schedule(jitter())
  }

  return {
    trigger,
    sessionChanged() {
      if (stopped) return
      const before = session
      syncSession()
      if (!sameSession(before, session)) {
        if (timer !== null) deps.timers.clearTimeout(timer)
        timer = null
        timerDue = Infinity
      }
      if (session) trigger("startup")
    },
    stop() {
      stopped = true
      supersede()
      if (timer !== null) deps.timers.clearTimeout(timer)
      timer = null
      stopListener()
      dueListener()
    },
  }
}
