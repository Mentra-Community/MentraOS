/// <reference types="bun-types" />
/**
 * The reconciler with the real data partitions and development selections: what a package's data and live-development
 * selection are once the account's workspace changes. The phone's miniapps are an in-memory port over the same
 * storage the app uses; the partition hook is the production one (the assignment's account and Core, as
 * `LocalMiniappRuntime` configures it).
 */
import {beforeEach, describe, expect, mock, test} from "bun:test"
import type {FleetAssignmentOutcomePayload, FleetDesiredState} from "@mentra/cloud-protocol"

import {fakeCreateMMKV, resetFakeMmkv} from "./fakeMmkv"

mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))
const partitions = await import("../../miniappDataPartition")
const {storage} = await import("../../../utils/storage/storage")
const {miniappContextRegistry} = await import("../../MiniappRunningRegistry")
const {createAssignmentReconciler, TRIGGER_JITTER_MS} = await import("../assignmentReconciler")
type ManagedAssignment = import("../assignmentReconciler").ManagedAssignment
type ManagedResolution = import("../assignmentReconciler").ManagedResolution
type AssignmentReconciler = import("../assignmentReconciler").AssignmentReconciler
type FleetManagementState = import("../fleetManagementState").FleetManagementState

const CORE = "https://core.mentra.glass"
const A = "ws_A"
const B = "ws_B"
const notes = "com.acme.notes"
const other = "com.acme.other"
const urlA = "https://notes.acme.example/a/"
const urlB = "https://notes.acme.example/b/"
const session = {coreUrl: CORE, mentraUserId: "mu_1"}
const partitionIn = (workspaceId: string | null) => partitions.partitionIdOf({...session, workspaceId})

class FakeTimers {
  now = Date.parse("2026-10-23T10:00:00.000Z")
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

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

function managed(revision: number, workspaceId: string, entries: {id: string; url: string; pkg?: string}[]) {
  return {
    status: "managed",
    revision,
    generatedAt: "2026-10-23T10:00:00.000Z",
    workspace: {workspaceId, name: workspaceId},
    entries: entries.map((e) => ({
      assignmentId: e.id,
      revision: 1,
      url: e.url,
      packageName: e.pkg ?? notes,
      selection: "latest",
    })),
  } as FleetDesiredState
}

let timers: FakeTimers
let fleetStore: Map<string, string>
let answer: () => Promise<FleetDesiredState>
let served: Map<string, ManagedResolution>
let installed: Map<string, string>
let assignments: Map<string, ManagedAssignment>
let outcomes: FleetAssignmentOutcomePayload[]
let management: FleetManagementState[]
let reconciler: AssignmentReconciler | null

function serve(url: string, version = "1.0.0", packageName = notes) {
  served.set(url, {ok: true, packageName, version, bundleUrl: `${url}bundle.zip`, bundleSha256: "c".repeat(64)})
}

/** What the app's registry answers for a live-development selection: a dev URL in the live keys. */
const devUrl = (packageName: string) => {
  const value = storage.load<string>(`${packageName}_dev_url`)
  return value.is_ok() ? value.value : undefined
}

function start(): AssignmentReconciler {
  const listeners = new Set<(packageName: string) => void>()
  miniappContextRegistry.onRemoved((packageName) => {
    for (const listener of listeners) listener(packageName)
  })
  reconciler = createAssignmentReconciler({
    client: {fetch: () => answer()},
    getSession: () => session,
    isOnline: () => true,
    store: {
      getString: (key) => fleetStore.get(key),
      set: (key, value) => void fleetStore.set(key, value),
      remove: (key) => void fleetStore.delete(key),
      getAllKeys: () => [...fleetStore.keys()],
    },
    emit: (outcome) => outcomes.push(outcome),
    onManagementState: (state) => management.push(state),
    timers,
    now: () => timers.now,
    random: () => 0,
    miniapps: {
      resolve: async (url) => served.get(url) ?? {ok: false, reason: "access_denied"},
      installedRelease: async (pkg) =>
        installed.has(pkg) ? {version: installed.get(pkg)!, bundleSha256: "c".repeat(64)} : null,
      hasOtherReason: () => false,
      assignment: (pkg) => assignments.get(pkg) ?? null,
      assignedPackages: () => [...assignments.keys()],
      hasDevelopmentSelection: (pkg) => devUrl(pkg) !== undefined || !partitions.isDevelopmentSelectionCurrent(pkg),
      clearDevelopmentSelection: async (pkg) => {
        if (!partitions.isDevelopmentSelectionCurrent(pkg)) return false
        storage.remove(`${pkg}_dev_url`)
        return true
      },
      allowsRelease: () => true,
      install: async ({resolution, assignment}) => {
        installed.set(resolution.packageName, resolution.version)
        storage.remove(`${resolution.packageName}_dev_url`)
        assignments.set(resolution.packageName, assignment)
        return {version: resolution.version}
      },
      classify: () => ({kind: "download_failed", retryable: true}),
      setAssignment: (pkg, assignment) => void assignments.set(pkg, assignment),
      clearAssignment: (pkg) => void assignments.delete(pkg),
      uninstall: async (pkg) => void installed.delete(pkg),
      isRunning: (pkg) => miniappContextRegistry.has(pkg),
      onStopped: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      onUpdateDue: () => () => {},
      revokeAccess: async () => {},
      restoreAccess: () => {},
      isAccessRevoked: () => false,
      dismissUpdatePrompt: () => {},
      setWorkspaceContext: (s, workspaceId) => partitions.setFleetWorkspace(s, workspaceId),
    },
  })
  return reconciler
}

async function reconcile(next: FleetDesiredState): Promise<void> {
  answer = async () => next
  reconciler!.trigger("revision", next.revision)
  await timers.advance(TRIGGER_JITTER_MS)
}

/** A fresh launch of the package: no context of it is live, so nothing is pinned. */
const freshPartition = () => partitions.resolveMiniappDataPartition(notes).id
const outcomeOf = (assignmentId: string) => outcomes.filter((o) => o.assignmentId === assignmentId).at(-1)

beforeEach(async () => {
  reconciler?.stop()
  for (const live of miniappContextRegistry.getAll()) miniappContextRegistry.remove(live)
  partitions.resetMiniappDataPartitionsForTests()
  resetFakeMmkv()
  timers = new FakeTimers()
  fleetStore = new Map()
  served = new Map()
  installed = new Map()
  assignments = new Map()
  outcomes = []
  management = []
  partitions.configureMiniappDataPartitions({
    getSession: () => session,
    // LocalMiniappRuntime's hook: the recorded assignment, when it is this account's on this Core.
    assignedWorkspace: (packageName, s) => {
      const assignment = assignments.get(packageName)
      return assignment && assignment.mentraUserId === s.mentraUserId && assignment.coreUrl === s.coreUrl
        ? assignment.workspaceId
        : null
    },
  })
  serve(urlA)
  answer = async () => managed(1, A, [{id: "asg_a", url: urlA}])
  start().trigger("startup")
  await timers.advance(TRIGGER_JITTER_MS)
  expect(assignments.get(notes)?.workspaceId).toBe(A)
  expect(freshPartition()).toBe(partitionIn(A))
})

describe("a workspace change with the same package assigned", () => {
  test("a failed install into the new workspace never runs the package in the old workspace's data", async () => {
    // B assigns the same package from a URL that refuses this account.
    await reconcile(managed(2, B, [{id: "asg_b", url: urlB}]))
    expect(outcomeOf("asg_a")?.state).toBe("withdrawn")
    expect(outcomeOf("asg_b")).toMatchObject({state: "blocked", reason: "access_denied"})
    expect(management.at(-1)).toEqual({status: "managed", workspaceId: B, workspaceName: B})
    // B has not admitted the account yet, so the package runs as the person's own, never in A's data.
    expect(freshPartition()).toBe(partitionIn(null))

    // After a restart too: what was stored never brings A back.
    reconciler!.stop()
    expect(freshPartition()).toBe(partitionIn(null))
    start().trigger("startup")
    await timers.advance(TRIGGER_JITTER_MS)
    expect(freshPartition()).toBe(partitionIn(null))
    expect(outcomeOf("asg_b")).toMatchObject({state: "blocked", reason: "access_denied"})
  })

  test("once the new workspace's URL admits the account, the package runs in that workspace's data", async () => {
    await reconcile(managed(2, B, [{id: "asg_b", url: urlB}]))
    serve(urlB)
    await reconcile(managed(3, B, [{id: "asg_b", url: urlB}]))
    expect(outcomeOf("asg_b")?.state).toBe("installed")
    expect(assignments.get(notes)?.workspaceId).toBe(B)
    expect(freshPartition()).toBe(partitionIn(B))
  })

  test("a running context keeps the data it started with until it stops", async () => {
    miniappContextRegistry.add(notes)
    expect(partitions.resolveMiniappDataPartition(notes).id).toBe(partitionIn(A))
    await reconcile(managed(2, B, [{id: "asg_b", url: urlB}]))
    // The live code was started in A and keeps A's data until it stops.
    expect(partitions.resolveMiniappDataPartition(notes).id).toBe(partitionIn(A))
    miniappContextRegistry.remove(notes)
    expect(freshPartition()).not.toBe(partitionIn(A))
  })

  test("leaving the workspace stops granting its data at once", async () => {
    answer = () => new Promise(() => {})
    reconciler!.trigger("leave")
    await timers.advance(0)
    expect(freshPartition()).toBe(partitionIn(null))
  })
})

describe("development selections across a workspace change", () => {
  test("B's managed release clears only B's selection of an idle package, even while another package runs", async () => {
    // In A, the developer selected live builds of notes (idle) and of another package that keeps running.
    storage.save(`${notes}_dev_url`, "http://192.168.1.5:5173")
    storage.save(`${other}_dev_url`, "http://192.168.1.5:5174")
    miniappContextRegistry.add(other)

    await reconcile(managed(2, B, [{id: "asg_b", url: urlA}]))
    // In B, notes has no selection of its own: the cached release satisfies B, with nothing to clear.
    expect(outcomeOf("asg_b")?.state).toBe("installed")
    expect(devUrl(notes)).toBeUndefined()
    // The running package keeps A's selection until it stops.
    expect(devUrl(other)).toBe("http://192.168.1.5:5174")
    miniappContextRegistry.remove(other)
    expect(devUrl(other)).toBeUndefined()

    // Back in A, both selections are A's again.
    partitions.setFleetWorkspace(session, A)
    expect(devUrl(notes)).toBe("http://192.168.1.5:5173")
    expect(devUrl(other)).toBe("http://192.168.1.5:5174")
  })
})
