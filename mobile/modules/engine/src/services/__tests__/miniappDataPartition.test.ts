/// <reference types="bun-types" />
import {beforeEach, describe, expect, mock, test} from "bun:test"

import {fakeCreateMMKV, resetFakeMmkv} from "../fleet/__tests__/fakeMmkv"

mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))
const partitions = await import("../miniappDataPartition")
const builds = await import("../miniappBuildKind")
const {miniappContextRegistry, miniappRunningRegistry} = await import("../MiniappRunningRegistry")

const CORE = "https://core.mentra.glass"
const pkg = "com.acme.notes"
let session: {coreUrl: string; mentraUserId: string} | null
const assigned = new Map<string, string>()

function configure() {
  partitions.configureMiniappDataPartitions({
    getSession: () => session,
    assignedWorkspace: (packageName) => assigned.get(packageName) ?? null,
  })
}

/** A projected context, as the router registers one: running and live. */
function startRunning(packageName: string): void {
  miniappContextRegistry.add(packageName)
  miniappRunningRegistry.add(packageName)
}

function stopRunning(packageName: string): void {
  miniappRunningRegistry.remove(packageName)
  miniappContextRegistry.remove(packageName)
}

beforeEach(() => {
  for (const running of miniappRunningRegistry.getAll()) miniappRunningRegistry.remove(running)
  for (const live of miniappContextRegistry.getAll()) miniappContextRegistry.remove(live)
  partitions.resetMiniappDataPartitionsForTests()
  resetFakeMmkv()
  session = {coreUrl: CORE, mentraUserId: "mu_1"}
  assigned.clear()
  configure()
})

/** The package is assigned by `workspaceId`, and that is the account's current workspace, as the reconciler records. */
function assignIn(workspaceId: string): void {
  assigned.set(pkg, workspaceId)
  partitions.setFleetWorkspace(session!, workspaceId)
}

describe("data partition of a package", () => {
  test("is the workspace's while that workspace assigned it, and personal otherwise", () => {
    const own = partitions.resolveMiniappDataPartition(pkg)
    expect(own.personalUserId).toBe("mu_1")
    assignIn("ws_A")
    const inA = partitions.resolveMiniappDataPartition(pkg)
    expect(inA.personalUserId).toBeNull()
    expect(inA.id).not.toBe(own.id)
    assignIn("ws_B")
    expect(partitions.resolveMiniappDataPartition(pkg).id).not.toBe(inA.id)
  })

  test("is never a workspace's that is no longer the account's current one, whatever the package's install recorded", () => {
    assignIn("ws_A")
    const inA = partitions.resolveMiniappDataPartition(pkg).id
    // B's desired state applied, but B's install did not replace A's assignment (B's URL refused the account).
    partitions.setFleetWorkspace(session!, "ws_B")
    const afterB = partitions.resolveMiniappDataPartition(pkg)
    expect(afterB.id).not.toBe(inA)
    expect(afterB.personalUserId).toBe("mu_1")
    // Leaving every workspace too.
    partitions.setFleetWorkspace(session!, "ws_A")
    expect(partitions.resolveMiniappDataPartition(pkg).id).toBe(inA)
    partitions.setFleetWorkspace(session!, null)
    expect(partitions.resolveMiniappDataPartition(pkg).personalUserId).toBe("mu_1")
  })

  test("says whether the account's current workspace assigned the package, even while a context pins another", () => {
    expect(partitions.isAssignedByCurrentWorkspace(pkg)).toBe(false)
    assignIn("ws_A")
    expect(partitions.isAssignedByCurrentWorkspace(pkg)).toBe(true)
    // A context started in A keeps A's data until it stops; what the workspace assigned changes at once.
    startRunning(pkg)
    partitions.resolveMiniappDataPartition(pkg)
    partitions.setFleetWorkspace(session!, "ws_B")
    expect(partitions.isAssignedByCurrentWorkspace(pkg)).toBe(false)
    stopRunning(pkg)
    partitions.setFleetWorkspace(session!, "ws_A")
    expect(partitions.isAssignedByCurrentWorkspace(pkg)).toBe(true)
    partitions.setFleetWorkspace(session!, null)
    expect(partitions.isAssignedByCurrentWorkspace(pkg)).toBe(false)
    partitions.setFleetWorkspace(session!, "ws_A")
    session = null
    expect(partitions.isAssignedByCurrentWorkspace(pkg)).toBe(false)
  })

  test("is safe as one file name, lower-case only", () => {
    session = {coreUrl: "https://Core.Example.com:8443/base/", mentraUserId: "User/../ID"}
    assignIn("WS.1")
    const {id} = partitions.resolveMiniappDataPartition(pkg)
    expect(id).toMatch(/^[a-z0-9_~.-]+$/)
    expect(id).not.toContain("..")
    expect(id.length).toBeLessThan(200)
  })

  test("changes only while the package is stopped", () => {
    assignIn("ws_A")
    startRunning(pkg)
    const running = partitions.resolveMiniappDataPartition(pkg).id
    // Leave A, join B while it runs: the running code keeps A's context.
    assignIn("ws_B")
    expect(partitions.resolveMiniappDataPartition(pkg).id).toBe(running)
    session = {coreUrl: CORE, mentraUserId: "mu_2"}
    partitions.setFleetWorkspace(session, "ws_B")
    expect(partitions.resolveMiniappDataPartition(pkg).id).toBe(running)
    stopRunning(pkg)
    const after = partitions.resolveMiniappDataPartition(pkg)
    expect(after.id).not.toBe(running)
    expect(after.id).toBe(partitions.partitionIdOf({coreUrl: CORE, mentraUserId: "mu_2", workspaceId: "ws_B"}))
  })

  test("of a hidden or background context stays pinned for that context's lifetime", () => {
    assignIn("ws_A")
    miniappContextRegistry.add(pkg)
    const live = partitions.resolveMiniappDataPartition(pkg).id
    assignIn("ws_B")
    expect(partitions.resolveMiniappDataPartition(pkg).id).toBe(live)
    miniappContextRegistry.remove(pkg)
    expect(partitions.resolveMiniappDataPartition(pkg).id).not.toBe(live)
  })

  test("is refused while no account is known", () => {
    session = null
    expect(() => partitions.resolveMiniappDataPartition(pkg)).toThrow("Mentra user identity is unavailable")
  })

  test("of a Core-free deployment is its identity's personal data, where earlier data migrates from", () => {
    const deploymentUser = "workspace:dep_1:https%3A%2F%2Flogin.example.com:sub-1"
    session = partitions.miniappDataSessionOf(null, deploymentUser)
    const own = partitions.resolveMiniappDataPartition(pkg)
    expect(own.personalUserId).toBe(deploymentUser)
    expect(own.id).toMatch(/^[a-z0-9_~.-]+$/)
    expect(partitions.miniappDataSessionOf({coreUrl: CORE, mentraUserId: "mu_1"}, deploymentUser)).toEqual({
      coreUrl: CORE,
      mentraUserId: "mu_1",
    })
    expect(partitions.miniappDataSessionOf({coreUrl: CORE, mentraUserId: null}, null)).toBeNull()
  })
})

describe("development selections an earlier Mentra App kept", () => {
  test("are handed over once, for the migration of development records, and every record of them goes", () => {
    const store = fakeCreateMMKV({id: partitions.MINIAPP_PARTITION_STORE_ID})
    store.set("devsel:ctx.a", JSON.stringify({[`${pkg}_dev_url`]: "http://192.168.1.5:3000", [`${pkg}_dev_port`]: 3001}))
    store.set("devsel:ctx.b", "not json")
    store.set("devsel.active", "ctx.c")
    store.set("devsel.held", JSON.stringify({[pkg]: "ctx.a"}))
    store.set(`devowner:${pkg}:dev-100`, "ctx.a")
    partitions.setFleetWorkspace(session!, "ws_1")

    expect(partitions.takeLegacyDevelopmentSelections()).toEqual([
      {[`${pkg}_dev_url`]: "http://192.168.1.5:3000", [`${pkg}_dev_port`]: 3001},
    ])
    expect(store.getAllKeys().filter((key) => key.startsWith("devsel") || key.startsWith("devowner:"))).toEqual([])
    // What partitions record stays.
    expect(partitions.getFleetWorkspace(session!)).toBe("ws_1")
    expect(partitions.takeLegacyDevelopmentSelections()).toEqual([])
  })
})

describe("a local or development build's data", () => {
  /** The router starts the package's context, recording which kind of build it runs first. */
  function startBuild(packageName: string, localBuild: boolean): void {
    builds.recordMiniappBuild(packageName, {localBuild})
    startRunning(packageName)
  }

  test("is its account's personal partition plus .local, with none of the data from before partitions", () => {
    const own = partitions.resolveMiniappDataPartition(pkg)
    startBuild(pkg, true)
    const local = partitions.resolveMiniappDataPartition(pkg)
    expect(local).toEqual({id: `${own.id}.local`, personalUserId: null})
    expect(builds.isLocalBuildContext(pkg)).toBe(true)
  })

  test("is never a workspace's, even for a package that workspace assigned", () => {
    assignIn("ws_A")
    const inA = partitions.resolveMiniappDataPartition(pkg).id
    startBuild(pkg, true)
    const local = partitions.resolveMiniappDataPartition(pkg)
    expect(local.id).not.toBe(inA)
    expect(local.id.endsWith(".p.local")).toBe(true)
    expect(partitions.miniappDataContext(pkg)).toEqual({
      coreUrl: CORE,
      mentraUserId: "mu_1",
      workspaceId: null,
      localBuild: true,
    })
  })

  test("is apart from every other install of the name, and the installed release's comes back after it", () => {
    startBuild(pkg, false)
    const release = partitions.resolveMiniappDataPartition(pkg).id
    stopRunning(pkg)
    startBuild(pkg, true)
    const local = partitions.resolveMiniappDataPartition(pkg).id
    expect(local).not.toBe(release)
    stopRunning(pkg)
    // The real one, installed again.
    startBuild(pkg, false)
    expect(partitions.resolveMiniappDataPartition(pkg).id).toBe(release)
    expect(builds.isLocalBuildContext(pkg)).toBe(false)
  })

  test("follows a context that starts again as another kind of build without stopping", () => {
    startBuild(pkg, false)
    const release = partitions.resolveMiniappDataPartition(pkg).id
    // A respawn re-registers the context in place.
    builds.recordMiniappBuild(pkg, {localBuild: true})
    expect(partitions.resolveMiniappDataPartition(pkg).id).toBe(`${release}.local`)
  })

  test("of one package leaves another package's alone", () => {
    startBuild(pkg, true)
    expect(builds.isLocalBuildContext("com.acme.other")).toBe(false)
    expect(partitions.resolveMiniappDataPartition("com.acme.other").personalUserId).toBe("mu_1")
  })
})
