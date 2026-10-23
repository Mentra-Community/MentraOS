import {beforeEach, describe, expect, test} from "bun:test"
import {
  FleetAssignmentOutcomePayloadSchema,
  type FleetAssignmentOutcomePayload,
  type FleetDesiredState,
} from "@mentra/cloud-protocol"

import {
  createAssignmentReconciler,
  FETCH_TIMEOUT_MS,
  RECONCILER_STORE_PREFIX,
  RETRY_BASE_MS,
  TRIGGER_JITTER_MS,
  type AssignmentReconciler,
  type ManagedAssignment,
  type ManagedInstallFailure,
  type ManagedResolution,
  type ReconcilerSession,
} from "../assignmentReconciler"
import type {FleetManagementState} from "../fleetManagementState"
import type {FleetKeyValueStore} from "../fleetQueue"

// ---- fakes ------------------------------------------------------------------------------------------------------

class FakeTimers {
  now = Date.parse("2026-10-22T10:00:00.000Z")
  private next = 1
  private queue: {id: number; due: number; callback: () => void}[] = []
  setTimeout = (callback: () => void, ms: number) => {
    const id = this.next++
    this.queue.push({id, due: this.now + ms, callback})
    return id
  }
  clearTimeout = (handle: unknown) => {
    this.queue = this.queue.filter((timer) => timer.id !== handle)
  }
  pending(): number {
    return this.queue.length
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      await settle()
      this.queue.sort((a, b) => a.due - b.due)
      const timer = this.queue[0]
      if (!timer || timer.due > target) break
      this.queue.shift()
      this.now = timer.due
      timer.callback()
    }
    this.now = target
    await settle()
  }
}

/** Lets every promise chain that is not waiting on a gate or a fake timer finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

function memoryStore(): FleetKeyValueStore & {values: Map<string, string>} {
  const values = new Map<string, string>()
  return {
    values,
    getString: (key) => values.get(key),
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
    getAllKeys: () => [...values.keys()],
  }
}

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return {promise, open}
}

class InstallFailure extends Error {
  constructor(
    readonly kind: ManagedInstallFailure,
    readonly retryable = false,
  ) {
    super(kind)
  }
}

const A = "ws_A"
const B = "ws_B"
const notes = "com.acme.notes"
const notesUrl = "https://notes.acme.example/app"
const sessionA: ReconcilerSession = {coreUrl: "https://core.mentra.glass", mentraUserId: "mu_1"}
const sessionB: ReconcilerSession = {coreUrl: "https://core.mentra.glass", mentraUserId: "mu_2"}

function managed(revision: number, entries: {id?: string; rev?: number; pkg?: string; url?: string}[] = [], ws = A) {
  return {
    status: "managed",
    revision,
    generatedAt: "2026-10-22T10:00:00.000Z",
    workspace: {workspaceId: ws, name: ws},
    entries: entries.map((e) => ({
      assignmentId: e.id ?? "asg_notes",
      revision: e.rev ?? 1,
      url: e.url ?? notesUrl,
      packageName: e.pkg ?? notes,
      selection: "latest",
    })),
  } as FleetDesiredState
}
const unmanaged = (revision: number) =>
  ({status: "unmanaged", revision, generatedAt: "2026-10-22T10:00:00.000Z"}) as FleetDesiredState

let timers: FakeTimers
let store: ReturnType<typeof memoryStore>
let reconciler: AssignmentReconciler | null
let session: ReconcilerSession | null
let online: boolean
let answer: () => Promise<FleetDesiredState>
let fetches: number
let served: Map<string, ManagedResolution>
let installed: Map<string, {version: string; bundleSha256?: string}>
let otherReasons: Set<string>
let assignments: Map<string, ManagedAssignment>
let running: Set<string>
let devSelections: Set<string>
/** Packages whose release this deployment's policy would not run. */
let disallowed: Set<string>
let revoked: Set<string>
let stopListeners: Set<(packageName: string) => void>
let dueListeners: Set<(packageName: string) => void>
let installGate: Promise<void> | undefined
let installError: InstallFailure | undefined
/** Packages whose install asks the person before it replaces the running release. */
let asks: Set<string>
let prompts: Map<string, (choice: "update" | "not_now" | "not_shown") => void>
let calls: string[]
let outcomes: FleetAssignmentOutcomePayload[]
let contexts: string[]
let management: FleetManagementState[]

function start(): AssignmentReconciler {
  reconciler = createAssignmentReconciler({
    client: {
      fetch: () => {
        fetches += 1
        return answer()
      },
    },
    getSession: () => session,
    isOnline: () => online,
    store,
    emit: (outcome) => outcomes.push(outcome),
    onManagementState: (state) => management.push(state),
    timers,
    now: () => timers.now,
    random: () => 0,
    miniapps: {
      resolve: async (url) => served.get(url) ?? {ok: false, reason: "not_a_miniapp"},
      installedRelease: async (pkg) => installed.get(pkg) ?? null,
      hasOtherReason: (pkg) => otherReasons.has(pkg),
      assignment: (pkg) => assignments.get(pkg) ?? null,
      assignedPackages: () => [...assignments.keys()],
      hasDevelopmentSelection: (pkg) => devSelections.has(pkg),
      allowsRelease: (pkg) => !disallowed.has(pkg),
      clearDevelopmentSelection: async (pkg) => {
        calls.push(`clear-dev:${pkg}`)
        devSelections.delete(pkg)
      },
      install: async ({resolution, assignment, isCancelled, onAsking}) => {
        calls.push(`install:${resolution.packageName}@${resolution.version}`)
        if (installGate) await installGate
        if (installError) throw installError
        if (asks.has(resolution.packageName)) {
          onAsking?.()
          const choice = await new Promise((resolve) => prompts.set(resolution.packageName, resolve))
          prompts.delete(resolution.packageName)
          if (choice !== "update") throw new InstallFailure("running", true)
        }
        if (isCancelled()) throw new InstallFailure("cancelled", true)
        installed.set(resolution.packageName, {version: resolution.version, bundleSha256: resolution.bundleSha256})
        devSelections.delete(resolution.packageName)
        assignments.set(resolution.packageName, assignment)
      },
      classify: (error) =>
        error instanceof InstallFailure
          ? {kind: error.kind, retryable: error.retryable}
          : {kind: "download_failed", retryable: true},
      setAssignment: (pkg, assignment) => {
        calls.push(`assign:${pkg}`)
        assignments.set(pkg, assignment)
      },
      clearAssignment: (pkg) => {
        calls.push(`unassign:${pkg}`)
        assignments.delete(pkg)
      },
      uninstall: async (pkg) => {
        calls.push(`uninstall:${pkg}`)
        installed.delete(pkg)
      },
      isRunning: (pkg) => running.has(pkg),
      onStopped: (listener) => {
        stopListeners.add(listener)
        return () => stopListeners.delete(listener)
      },
      onUpdateDue: (listener) => {
        dueListeners.add(listener)
        return () => dueListeners.delete(listener)
      },
      revokeAccess: async (pkg) => {
        calls.push(`revoke:${pkg}`)
        revoked.add(pkg)
        running.delete(pkg)
      },
      restoreAccess: (pkg) => {
        calls.push(`restore:${pkg}`)
        revoked.delete(pkg)
      },
      isAccessRevoked: (pkg) => revoked.has(pkg),
      dismissUpdatePrompt: (pkg) => {
        calls.push(`dismiss:${pkg}`)
        prompts.get(pkg)?.("not_shown")
      },
      setWorkspaceContext: (s, ws) => contexts.push(`${s.mentraUserId}:${ws ?? "none"}`),
    },
  })
  return reconciler
}

function stop(pkg: string): void {
  running.delete(pkg)
  for (const listener of [...stopListeners]) listener(pkg)
}

function serve(version: string, extra: Partial<Extract<ManagedResolution, {ok: true}>> = {}, url = notesUrl) {
  served.set(url, {
    ok: true,
    packageName: notes,
    version,
    bundleUrl: `${url}/bundle.zip`,
    bundleSha256: "c".repeat(64),
    ...extra,
  })
}

const states = (pkg?: string) =>
  outcomes.filter((o) => !pkg || o.packageName === pkg).map((o) => (o.reason ? `${o.state}:${o.reason}` : o.state))

async function startAndSettle(): Promise<AssignmentReconciler> {
  const r = start()
  r.trigger("startup")
  await timers.advance(TRIGGER_JITTER_MS)
  return r
}

beforeEach(() => {
  timers = new FakeTimers()
  store = memoryStore()
  reconciler = null
  session = sessionA
  online = true
  answer = async () => managed(1, [{}])
  fetches = 0
  served = new Map()
  installed = new Map()
  otherReasons = new Set()
  assignments = new Map()
  running = new Set()
  devSelections = new Set()
  disallowed = new Set()
  revoked = new Set()
  stopListeners = new Set()
  dueListeners = new Set()
  installGate = undefined
  installError = undefined
  asks = new Set()
  prompts = new Map()
  calls = []
  outcomes = []
  contexts = []
  management = []
  serve("1.0.0")
})

// ---- tests ------------------------------------------------------------------------------------------------------

describe("triggers", () => {
  test("startup, foreground and an ack revision arriving together make one fetch", async () => {
    const r = start()
    r.trigger("startup")
    r.trigger("foreground")
    r.trigger("revision", 5)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(fetches).toBe(1)
  })

  test("an ack revision that is not newer than the applied one fetches nothing", async () => {
    answer = async () => managed(4, [{}])
    const r = await startAndSettle()
    expect(fetches).toBe(1)
    r.trigger("revision", 3)
    r.trigger("revision", 4)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(fetches).toBe(1)
    r.trigger("revision", 5)
    r.trigger("revision", 5)
    answer = async () => managed(5, [{}])
    await timers.advance(TRIGGER_JITTER_MS)
    expect(fetches).toBe(2)
  })

  test("a newer revision heard mid-install refuses the stale commit, then applies the newer revision", async () => {
    const install = gate()
    installGate = install.promise
    const r = start()
    r.trigger("startup")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0"])
    r.trigger("revision", 2)
    answer = async () => managed(2, [])
    installGate = undefined
    install.open()
    await timers.advance(TRIGGER_JITTER_MS)
    expect(fetches).toBe(2)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0"])
    expect(installed.has(notes)).toBe(false)
    expect(states()).toEqual(["downloading", "withdrawn"])
  })

  test("a revision heard mid-install that the next answer still wants installs it then", async () => {
    const install = gate()
    installGate = install.promise
    const r = start()
    r.trigger("startup")
    await timers.advance(TRIGGER_JITTER_MS)
    r.trigger("revision", 2)
    answer = async () => managed(2, [{}])
    installGate = undefined
    install.open()
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0", "install:com.acme.notes@1.0.0"])
    expect(installed.get(notes)?.version).toBe("1.0.0")
    expect(states().at(-1)).toBe("installed")
  })

  test("leaving a workspace reads desired state at once", async () => {
    const r = await startAndSettle()
    answer = async () => unmanaged(2)
    r.trigger("leave")
    await timers.advance(0)
    expect(fetches).toBe(2)
  })
})

describe("managed desired state", () => {
  test("a missing package installs silently from its URL, and the URL decides the version", async () => {
    serve("3.2.1")
    await startAndSettle()
    expect(calls).toEqual(["install:com.acme.notes@3.2.1"])
    expect(assignments.get(notes)).toMatchObject({assignmentId: "asg_notes", workspaceId: A, url: notesUrl})
    expect(contexts).toEqual(["mu_1:ws_A"])
    expect(states()).toEqual(["downloading", "installed"])
    expect(outcomes.at(-1)).toMatchObject({
      assignmentId: "asg_notes",
      assignmentRevision: 1,
      desiredRevision: 1,
      packageName: notes,
      selectedVersion: "3.2.1",
      installedVersion: "3.2.1",
      attempts: 1,
      attemptedAt: "2026-10-22T10:00:00.000Z",
      lastSuccessAt: "2026-10-22T10:00:00.000Z",
    })
    for (const outcome of outcomes) expect(FleetAssignmentOutcomePayloadSchema.safeParse(outcome).success).toBe(true)
  })

  test("a satisfied assignment never reinstalls; a removed package reinstalls", async () => {
    const r = await startAndSettle()
    r.trigger("foreground")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0"])
    expect(outcomes).toHaveLength(2)
    installed.delete(notes)
    r.trigger("foreground")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0", "install:com.acme.notes@1.0.0"])
  })

  test("an explicit install of the same version is adopted without reinstalling", async () => {
    installed.set(notes, {version: "1.0.0"})
    otherReasons.add(notes)
    await startAndSettle()
    expect(calls).toEqual(["assign:com.acme.notes"])
    expect(states()).toEqual(["installed"])
  })

  test("the same version with different bytes reinstalls", async () => {
    installed.set(notes, {version: "1.0.0", bundleSha256: "a".repeat(64)})
    serve("1.0.0", {bundleSha256: "b".repeat(64)})
    await startAndSettle()
    expect(calls).toEqual(["install:com.acme.notes@1.0.0"])
  })

  test("a higher installed version is newer_version_installed and is not replaced", async () => {
    installed.set(notes, {version: "2.0.0"})
    await startAndSettle()
    expect(calls).toEqual([])
    expect(outcomes).toEqual([
      expect.objectContaining({state: "blocked", reason: "newer_version_installed", installedVersion: "2.0.0"}),
    ])
  })

  test.each([
    ["incompatible_host", false, "blocked:incompatible_host"],
    ["signature_invalid", false, "blocked:signature_invalid"],
    ["storage_full", true, "retrying:storage_full"],
  ] as const)("an install refused as %s is reported", async (kind, retryable, state) => {
    installed.set(notes, {version: "0.9.0"})
    installError = new InstallFailure(kind, retryable)
    await startAndSettle()
    expect(states()).toEqual(["downloading", state])
    // The previous install stays.
    expect(installed.get(notes)).toEqual({version: "0.9.0"})
    expect(outcomes.at(-1)?.installedVersion).toBe("0.9.0")
  })

  test("a refused release is not downloaded again until the URL serves another version", async () => {
    installError = new InstallFailure("signature_invalid")
    const r = await startAndSettle()
    r.trigger("foreground")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toHaveLength(1)
    serve("1.0.1")
    installError = undefined
    r.trigger("foreground")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0", "install:com.acme.notes@1.0.1"])
  })

  test.each(["archived", "not_a_miniapp"] as const)("%s is reported and withdraws nothing", async (reason) => {
    const r = await startAndSettle()
    served.set(notesUrl, {ok: false, reason})
    answer = async () => managed(2, [{rev: 2}])
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(states().at(-1)).toBe(`blocked:${reason}`)
    expect(assignments.has(notes)).toBe(true)
    expect(calls).not.toContain("uninstall:com.acme.notes")
    expect(calls).not.toContain("unassign:com.acme.notes")
  })

  test("a release the deployment would not run is blocked, not installed or reported installed", async () => {
    disallowed.add(notes)
    const r = await startAndSettle()
    expect(calls).toEqual([])
    expect(states()).toEqual(["blocked:incompatible_host"])

    installed.set(notes, {version: "1.0.0", bundleSha256: "c".repeat(64)})
    answer = async () => managed(2, [{rev: 2}])
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual([])
    expect(states().at(-1)).toBe("blocked:incompatible_host")

    disallowed.clear()
    r.trigger("foreground")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["assign:com.acme.notes"])
    expect(states().at(-1)).toBe("installed")
  })

  test("a running miniapp is deferred_running and installs when it stops", async () => {
    installed.set(notes, {version: "0.9.0"})
    running.add(notes)
    installError = new InstallFailure("running", true)
    await startAndSettle()
    expect(states()).toEqual(["downloading", "deferred_running"])
    installError = undefined
    stop(notes)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(states()).toEqual(["downloading", "deferred_running", "downloading", "installed"])
    expect(installed.get(notes)?.version).toBe("1.0.0")
  })

  test("a deferred update tries again when the person opens the miniapp after Not now, and not for others", async () => {
    installed.set(notes, {version: "0.9.0"})
    running.add(notes)
    installError = new InstallFailure("running", true)
    await startAndSettle()
    for (const listener of [...dueListeners]) listener("com.acme.other")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(fetches).toBe(1)
    installError = undefined
    for (const listener of [...dueListeners]) listener(notes)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(fetches).toBe(2)
    expect(states()).toEqual(["downloading", "deferred_running", "downloading", "installed"])
  })

  test("an unanswered update prompt holds neither other assignments nor later triggers", async () => {
    const other = "com.acme.other"
    const otherUrl = "https://other.acme.example/app"
    serve("2.0.0", {packageName: other}, otherUrl)
    answer = async () => managed(1, [{}, {id: "asg_other", pkg: other, url: otherUrl}])
    installed.set(notes, {version: "0.9.0"})
    running.add(notes)
    asks.add(notes)
    const r = await startAndSettle()
    expect(states(notes)).toEqual(["downloading", "deferred_running"])
    expect(states(other)).toEqual(["downloading", "installed"])
    r.trigger("foreground")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(fetches).toBe(2)
    expect(calls.filter((call) => call.startsWith(`install:${notes}`))).toHaveLength(1)
    prompts.get(notes)!("update")
    await settle()
    expect(installed.get(notes)?.version).toBe("1.0.0")
    expect(states(notes)).toEqual(["downloading", "deferred_running", "installed"])
  })

  test("a newer release dismisses the unanswered prompt of the one it supersedes", async () => {
    installed.set(notes, {version: "0.9.0"})
    running.add(notes)
    asks.add(notes)
    const r = await startAndSettle()
    serve("1.1.0")
    answer = async () => managed(2, [{}])
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0", "dismiss:com.acme.notes", "install:com.acme.notes@1.1.0"])
    prompts.get(notes)!("update")
    await settle()
    expect(installed.get(notes)?.version).toBe("1.1.0")
  })

  test("a withdrawn assignment and a context change dismiss its unanswered prompt", async () => {
    installed.set(notes, {version: "0.9.0"})
    running.add(notes)
    asks.add(notes)
    const r = await startAndSettle()
    answer = async () => managed(2, [])
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0", "dismiss:com.acme.notes"])
    expect(installed.get(notes)?.version).toBe("0.9.0")

    calls = []
    answer = async () => managed(3, [{}])
    r.trigger("revision", 3)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0"])
    session = sessionB
    answer = async () => unmanaged(1)
    r.sessionChanged()
    expect(calls).toContain("dismiss:com.acme.notes")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(installed.get(notes)?.version).toBe("0.9.0")
  })

  test("the cached release satisfies the assignment once a stopped live-development selection is cleared", async () => {
    installed.set(notes, {version: "1.0.0", bundleSha256: "c".repeat(64)})
    devSelections.add(notes)
    await startAndSettle()
    expect(calls).toEqual(["clear-dev:com.acme.notes", "assign:com.acme.notes"])
    expect(states()).toEqual(["installed"])
  })

  test("a running live-development selection is deferred_running, then cleared when it stops", async () => {
    installed.set(notes, {version: "1.0.0", bundleSha256: "c".repeat(64)})
    devSelections.add(notes)
    running.add(notes)
    await startAndSettle()
    expect(calls).toEqual([])
    expect(states()).toEqual(["deferred_running"])
    stop(notes)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["clear-dev:com.acme.notes", "assign:com.acme.notes"])
    expect(states()).toEqual(["deferred_running", "installed"])
  })
})

describe("withdrawal", () => {
  test("empty entries clear the assignment reason and keep the workspace context; data is kept", async () => {
    const r = await startAndSettle()
    answer = async () => managed(2, [])
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls.slice(1)).toEqual(["unassign:com.acme.notes", "uninstall:com.acme.notes"])
    expect(contexts).toEqual(["mu_1:ws_A"])
    expect(states().at(-1)).toBe("withdrawn")
    expect(FleetAssignmentOutcomePayloadSchema.safeParse(outcomes.at(-1)).success).toBe(true)
  })

  test("a package the user also installed, or that is bundled or in a manifest, stays", async () => {
    const r = await startAndSettle()
    otherReasons.add(notes)
    answer = async () => managed(2, [])
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls.slice(1)).toEqual(["unassign:com.acme.notes"])
    expect(installed.has(notes)).toBe(true)
  })

  test("a withdrawn running miniapp uninstalls only once it stops, also after a restart", async () => {
    let r = await startAndSettle()
    running.add(notes)
    answer = async () => managed(2, [])
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).not.toContain("uninstall:com.acme.notes")
    r.stop()
    stopListeners.clear()
    r = start()
    stop(notes)
    await timers.advance(0)
    expect(calls).not.toContain("uninstall:com.acme.notes")
    r.trigger("startup")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls.at(-1)).toBe("uninstall:com.acme.notes")
  })

  test("unmanaged clears the reasons and the workspace context", async () => {
    const r = await startAndSettle()
    answer = async () => unmanaged(2)
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls.slice(1)).toEqual(["unassign:com.acme.notes", "uninstall:com.acme.notes"])
    expect(contexts).toEqual(["mu_1:ws_A", "mu_1:none"])
  })

  test("a removed member's running miniapp is not stopped or revoked; it uninstalls once it stops", async () => {
    const r = await startAndSettle()
    running.add(notes)
    answer = async () => unmanaged(2)
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls.slice(1)).toEqual(["unassign:com.acme.notes"])
    expect(running.has(notes)).toBe(true)
    expect(revoked.has(notes)).toBe(false)
    stop(notes)
    await timers.advance(0)
    expect(calls.slice(1)).toEqual(["unassign:com.acme.notes", "uninstall:com.acme.notes"])
    expect(revoked.has(notes)).toBe(false)
  })

  test("a removed member's idle miniapp uninstalls once and leaves nothing pending or revoked", async () => {
    const r = await startAndSettle()
    answer = async () => unmanaged(2)
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS)
    stop(notes)
    r.trigger("foreground")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls.slice(1)).toEqual(["unassign:com.acme.notes", "uninstall:com.acme.notes"])
    expect(revoked.size).toBe(0)
    const persisted = [...store.values.entries()].find(([key]) => key.startsWith(RECONCILER_STORE_PREFIX))
    expect(JSON.parse(persisted![1])).toMatchObject({pendingUninstalls: [], revoked: [], outcomes: {}})
  })
})

describe("answers that change nothing", () => {
  test.each([
    ["an error", async () => Promise.reject(new Error("HTTP 500"))],
    [
      "a 503 fleet_unavailable",
      async () => Promise.reject(Object.assign(new Error("fleet_unavailable"), {status: 503})),
    ],
    ["a partial answer", async () => ({status: "managed", revision: 2}) as unknown as FleetDesiredState],
    [
      "an unknown status",
      async () =>
        ({status: "paused", revision: 2, generatedAt: "2026-10-22T10:00:00.000Z"}) as unknown as FleetDesiredState,
    ],
  ])("%s keeps the last snapshot and retries with backoff", async (_name, failing) => {
    const r = await startAndSettle()
    const before = {calls: [...calls], outcomes: outcomes.length, contexts: [...contexts]}
    answer = failing
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS)
    expect({calls, outcomes: outcomes.length, contexts}).toEqual(before)
    expect(assignments.has(notes)).toBe(true)
    answer = async () => managed(2, [{}])
    await timers.advance(RETRY_BASE_MS)
    expect(fetches).toBe(3)
  })

  test("a timeout changes nothing", async () => {
    const r = await startAndSettle()
    answer = () => new Promise<FleetDesiredState>(() => {})
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS + FETCH_TIMEOUT_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0"])
    expect(states()).toEqual(["downloading", "installed"])
  })

  test("an older revision than the applied one is ignored", async () => {
    answer = async () => managed(5, [{}])
    const r = await startAndSettle()
    answer = async () => managed(4, [])
    r.trigger("foreground")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0"])
  })
})

describe("context changes", () => {
  test("an account switch mid-download refuses the commit", async () => {
    const install = gate()
    installGate = install.promise
    const r = start()
    r.trigger("startup")
    await timers.advance(TRIGGER_JITTER_MS)
    session = sessionB
    answer = async () => unmanaged(1)
    r.sessionChanged()
    install.open()
    await timers.advance(TRIGGER_JITTER_MS)
    expect(installed.has(notes)).toBe(false)
    expect(states()).toEqual(["downloading"])
  })

  test("leaving A and joining B invalidates A's in-flight work before B activates", async () => {
    const install = gate()
    installGate = install.promise
    const r = start()
    r.trigger("startup")
    await timers.advance(TRIGGER_JITTER_MS)
    answer = async () => managed(2, [], B)
    r.trigger("leave")
    install.open()
    installGate = undefined
    await timers.advance(TRIGGER_JITTER_MS)
    expect(installed.has(notes)).toBe(false)
    expect(contexts).toEqual(["mu_1:ws_A", "mu_1:ws_B"])
  })

  test("a kill mid-install leaves no lock: the next start installs", async () => {
    installGate = gate().promise
    const r = start()
    r.trigger("startup")
    await timers.advance(TRIGGER_JITTER_MS)
    r.stop()
    stopListeners.clear()
    installGate = undefined
    reconciler = null
    await startAndSettle()
    expect(installed.get(notes)?.version).toBe("1.0.0")
  })

  test("sign-out uninstalls nothing", async () => {
    const r = await startAndSettle()
    session = null
    r.sessionChanged()
    await timers.advance(TRIGGER_JITTER_MS * 10)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0"])
    expect(installed.has(notes)).toBe(true)
  })

  test("the next account's complete desired state decides the previous account's assignment reasons", async () => {
    const r = await startAndSettle()
    session = sessionB
    answer = async () => managed(1, [], B)
    r.sessionChanged()
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0", "unassign:com.acme.notes", "uninstall:com.acme.notes"])
    expect(outcomes.filter((outcome) => outcome.state === "withdrawn")).toEqual([])
  })

  test("the next account's assignment of the same package takes the reason over without reinstalling", async () => {
    const r = await startAndSettle()
    session = sessionB
    answer = async () => managed(1, [{id: "asg_b"}], B)
    r.sessionChanged()
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0", "assign:com.acme.notes"])
    expect(assignments.get(notes)).toMatchObject({assignmentId: "asg_b", mentraUserId: "mu_2", workspaceId: B})
  })

  test("the next account's failed desired state keeps the previous account's assignment reasons", async () => {
    const r = await startAndSettle()
    session = sessionB
    answer = async () => Promise.reject(Object.assign(new Error("fleet_unavailable"), {status: 503}))
    r.sessionChanged()
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0"])
    expect(assignments.has(notes)).toBe(true)
  })

  test("offline starts no install; reconnect reconciles", async () => {
    online = false
    const r = await startAndSettle()
    expect(fetches).toBe(0)
    expect(calls).toEqual([])
    online = true
    r.trigger("reconnect")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(calls).toEqual(["install:com.acme.notes@1.0.0"])
  })
})

describe("managed signal", () => {
  const managedA = {status: "managed", workspaceId: A, workspaceName: A}
  const last = () => management.at(-1)

  test("is unknown before the first answer, then follows each complete answer", async () => {
    answer = () => new Promise<FleetDesiredState>(() => {})
    const r = start()
    r.trigger("startup")
    await timers.advance(0)
    expect(last()).toEqual({status: "unknown"})
    answer = async () => managed(1, [{}])
    await timers.advance(TRIGGER_JITTER_MS + FETCH_TIMEOUT_MS + RETRY_BASE_MS)
    expect(last()).toEqual(managedA)
    answer = async () => unmanaged(2)
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(last()).toEqual({status: "unmanaged"})
  })

  test.each([
    ["an error", async () => Promise.reject(new Error("HTTP 500"))],
    ["a 503", async () => Promise.reject(Object.assign(new Error("fleet_unavailable"), {status: 503}))],
    ["a partial answer", async () => ({status: "managed", revision: 2}) as unknown as FleetDesiredState],
    [
      "an unknown status",
      async () =>
        ({status: "paused", revision: 2, generatedAt: "2026-10-22T10:00:00.000Z"}) as unknown as FleetDesiredState,
    ],
  ])("%s keeps the last answer", async (_name, failing) => {
    const r = await startAndSettle()
    answer = failing
    r.trigger("revision", 2)
    await timers.advance(TRIGGER_JITTER_MS)
    expect(last()).toEqual(managedA)
  })

  test("is unknown when signed out and comes back from the account's stored answer, also after a restart", async () => {
    let r = await startAndSettle()
    session = null
    r.sessionChanged()
    expect(last()).toEqual({status: "unknown"})
    session = sessionB
    answer = () => new Promise<FleetDesiredState>(() => {})
    r.sessionChanged()
    expect(last()).toEqual({status: "unknown"})
    r.stop()
    stopListeners.clear()
    dueListeners.clear()
    session = sessionA
    management = []
    r = start()
    r.trigger("startup")
    expect(management).toEqual([managedA])
  })
})

describe("access", () => {
  test("access_denied stops updates and leaves the running miniapp alone, even a manual install", async () => {
    installed.set(notes, {version: "1.0.0"})
    otherReasons.add(notes)
    running.add(notes)
    served.set(notesUrl, {ok: false, reason: "access_denied"})
    await startAndSettle()
    expect(calls).not.toContain("revoke:com.acme.notes")
    expect(revoked.has(notes)).toBe(false)
    expect(running.has(notes)).toBe(true)
    expect(installed.has(notes)).toBe(true)
    expect(states()).toEqual(["blocked:access_denied"])
  })

  test("access that returns lifts the block", async () => {
    installed.set(notes, {version: "1.0.0"})
    served.set(notesUrl, {ok: false, reason: "access_denied"})
    const r = await startAndSettle()
    serve("1.0.0")
    r.trigger("foreground")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(revoked.has(notes)).toBe(false)
    expect(states()).toEqual(["blocked:access_denied", "installed"])
  })

  test("a launch block stored by an older build is lifted, and it is not put back", async () => {
    installed.set(notes, {version: "1.0.0"})
    revoked.add(notes)
    store.set(
      `fleet.assignments.v1/${sessionA.coreUrl}|${sessionA.mentraUserId}`,
      JSON.stringify({revoked: [notes]}),
    )
    served.set(notesUrl, {ok: false, reason: "access_denied"})
    const r = await startAndSettle()
    expect(revoked.has(notes)).toBe(false)
    expect(calls).toContain("restore:com.acme.notes")
    session = sessionB
    answer = async () => unmanaged(1)
    r.sessionChanged()
    await timers.advance(TRIGGER_JITTER_MS)
    session = sessionA
    served.set(notesUrl, {ok: false, reason: "access_denied"})
    r.sessionChanged()
    await timers.advance(TRIGGER_JITTER_MS)
    expect(revoked.has(notes)).toBe(false)
    expect(calls.filter((call) => call.startsWith("revoke:"))).toEqual([])
  })
})
