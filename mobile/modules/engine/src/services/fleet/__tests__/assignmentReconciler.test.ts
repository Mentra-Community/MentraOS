import {beforeEach, describe, expect, test} from "bun:test"
import {
  FleetAssignmentOutcomePayloadSchema,
  type FleetAssignmentOutcomePayload,
  type FleetDesiredState,
} from "@mentra/cloud-protocol"

import {
  createAssignmentReconciler,
  FETCH_TIMEOUT_MS,
  RETRY_BASE_MS,
  TRIGGER_JITTER_MS,
  type AssignmentReconciler,
  type ManagedAssignment,
  type ManagedInstallFailure,
  type ManagedResolution,
  type ReconcilerSession,
} from "../assignmentReconciler"
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
let revoked: Set<string>
let stopListeners: Set<(packageName: string) => void>
let installGate: Promise<void> | undefined
let installError: InstallFailure | undefined
let calls: string[]
let outcomes: FleetAssignmentOutcomePayload[]
let contexts: string[]

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
    timers,
    now: () => timers.now,
    random: () => 0,
    miniapps: {
      resolve: async (url) => served.get(url) ?? {ok: false, reason: "not_a_miniapp"},
      installedRelease: async (pkg) => installed.get(pkg) ?? null,
      hasOtherReason: (pkg) => otherReasons.has(pkg),
      assignment: (pkg) => assignments.get(pkg) ?? null,
      install: async ({resolution, assignment, isCancelled}) => {
        calls.push(`install:${resolution.packageName}@${resolution.version}`)
        if (installGate) await installGate
        if (installError) throw installError
        if (isCancelled()) throw new InstallFailure("cancelled", true)
        installed.set(resolution.packageName, {
          version: resolution.version,
          ...(resolution.bundleSha256 ? {bundleSha256: resolution.bundleSha256} : {}),
        })
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

const states = () => outcomes.map((o) => (o.reason ? `${o.state}:${o.reason}` : o.state))

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
  revoked = new Set()
  stopListeners = new Set()
  installGate = undefined
  installError = undefined
  calls = []
  outcomes = []
  contexts = []
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

  test("a newer revision heard mid-install re-evaluates after it", async () => {
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
    expect(calls).toEqual(["install:com.acme.notes@1.0.0", "unassign:com.acme.notes", "uninstall:com.acme.notes"])
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

describe("access", () => {
  test("access_denied blocks launch and stops the miniapp now, even a manual install, and withdraws nothing", async () => {
    installed.set(notes, {version: "1.0.0"})
    otherReasons.add(notes)
    running.add(notes)
    served.set(notesUrl, {ok: false, reason: "access_denied"})
    await startAndSettle()
    expect(calls).toEqual(["revoke:com.acme.notes"])
    expect(revoked.has(notes)).toBe(true)
    expect(running.has(notes)).toBe(false)
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

  test("one account's revocation does not block another account", async () => {
    installed.set(notes, {version: "1.0.0"})
    served.set(notesUrl, {ok: false, reason: "access_denied"})
    const r = await startAndSettle()
    session = sessionB
    answer = async () => unmanaged(1)
    r.sessionChanged()
    await timers.advance(TRIGGER_JITTER_MS)
    expect(revoked.has(notes)).toBe(false)
    session = sessionA
    r.sessionChanged()
    expect(revoked.has(notes)).toBe(true)
  })
})
