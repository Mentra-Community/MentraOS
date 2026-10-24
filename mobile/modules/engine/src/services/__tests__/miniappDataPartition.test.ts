/// <reference types="bun-types" />
import {beforeEach, describe, expect, mock, test} from "bun:test"

import {fakeCreateMMKV, mmkvInstances, resetFakeMmkv} from "../fleet/__tests__/fakeMmkv"

mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))
const partitions = await import("../miniappDataPartition")
const builds = await import("../miniappBuildKind")
const {storage} = await import("../../utils/storage/storage")
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

function load(key: string): unknown {
  const value = storage.load<unknown>(key)
  return value.is_ok() ? value.value : undefined
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

describe("development selections", () => {
  test("of workspace A are invisible in workspace B, and come back in A", () => {
    partitions.setFleetWorkspace(session!, "ws_A")
    storage.save(`${pkg}_dev_url`, "http://192.168.1.5:5173")
    storage.save(`${pkg}_dev_selected_snapshot`, "dev-1")
    storage.save("dev_apps_index", JSON.stringify([pkg]))
    storage.save("unrelated_setting", "kept")

    partitions.setFleetWorkspace(session!, null)
    partitions.setFleetWorkspace(session!, "ws_B")
    expect(load(`${pkg}_dev_url`)).toBeUndefined()
    expect(load(`${pkg}_dev_selected_snapshot`)).toBeUndefined()
    expect(load("dev_apps_index")).toBeUndefined()
    expect(load("unrelated_setting")).toBe("kept")

    storage.save(`${pkg}_dev_url`, "http://10.0.0.9:5173")
    partitions.setFleetWorkspace(session!, "ws_A")
    expect(load(`${pkg}_dev_url`)).toBe("http://192.168.1.5:5173")
    expect(load(`${pkg}_dev_selected_snapshot`)).toBe("dev-1")
    partitions.setFleetWorkspace(session!, "ws_B")
    expect(load(`${pkg}_dev_url`)).toBe("http://10.0.0.9:5173")
  })

  test("follow the account: another account never sees them", () => {
    storage.save(`${pkg}_dev_url`, "http://192.168.1.5:5173")
    session = {coreUrl: CORE, mentraUserId: "mu_2"}
    partitions.syncDevelopmentSelections()
    expect(load(`${pkg}_dev_url`)).toBeUndefined()
    session = {coreUrl: CORE, mentraUserId: "mu_1"}
    partitions.syncDevelopmentSelections()
    expect(load(`${pkg}_dev_url`)).toBe("http://192.168.1.5:5173")
  })

  test("wait for a running package to stop before switching", () => {
    storage.save(`${pkg}_dev_url`, "http://192.168.1.5:5173")
    startRunning(pkg)
    partitions.setFleetWorkspace(session!, "ws_B")
    expect(load(`${pkg}_dev_url`)).toBe("http://192.168.1.5:5173")
    stopRunning(pkg)
    expect(load(`${pkg}_dev_url`)).toBeUndefined()
  })

  test("of a stopped package switch at once while another package's live context keeps its own", () => {
    const other = "com.acme.other"
    partitions.setFleetWorkspace(session!, "ws_A")
    storage.save(`${pkg}_dev_url`, "A's notes")
    storage.save(`${other}_dev_url`, "A's other")
    storage.save("dev_apps_index", JSON.stringify([pkg, other]))
    partitions.setFleetWorkspace(session!, "ws_B")
    storage.save(`${pkg}_dev_url`, "B's notes")
    storage.save("dev_apps_index", JSON.stringify([pkg]))
    partitions.setFleetWorkspace(session!, "ws_A")
    expect(load(`${pkg}_dev_url`)).toBe("A's notes")

    startRunning(other)
    partitions.setFleetWorkspace(session!, "ws_B")
    // notes is stopped: B's at once. other runs: A's, held, and not current.
    expect(load(`${pkg}_dev_url`)).toBe("B's notes")
    expect(load(`${other}_dev_url`)).toBe("A's other")
    expect(JSON.parse(load("dev_apps_index") as string)).toEqual([other, pkg])
    expect(partitions.isDevelopmentSelectionCurrent(pkg)).toBe(true)
    expect(partitions.isDevelopmentSelectionCurrent(other)).toBe(false)
    // Clearing notes in B leaves A's selections alone.
    storage.remove(`${pkg}_dev_url`)
    stopRunning(other)
    expect(load(`${other}_dev_url`)).toBeUndefined()
    expect(partitions.isDevelopmentSelectionCurrent(other)).toBe(true)
    expect(JSON.parse(load("dev_apps_index") as string)).toEqual([pkg])

    partitions.setFleetWorkspace(session!, "ws_A")
    expect(load(`${pkg}_dev_url`)).toBe("A's notes")
    expect(load(`${other}_dev_url`)).toBe("A's other")
    expect([...JSON.parse(load("dev_apps_index") as string)].sort()).toEqual([other, pkg].sort())
  })

  test("held for a running package come back unchanged when its context returns first", () => {
    partitions.setFleetWorkspace(session!, "ws_A")
    storage.save(`${pkg}_dev_url`, "A's")
    startRunning(pkg)
    partitions.setFleetWorkspace(session!, "ws_B")
    partitions.setFleetWorkspace(session!, "ws_A")
    expect(partitions.isDevelopmentSelectionCurrent(pkg)).toBe(true)
    stopRunning(pkg)
    expect(load(`${pkg}_dev_url`)).toBe("A's")
  })

  test("of a running package's own new snapshot belong to the context it holds", () => {
    partitions.setFleetWorkspace(session!, "ws_A")
    storage.save(`${pkg}_dev_url`, "A's")
    startRunning(pkg)
    partitions.setFleetWorkspace(session!, "ws_B")
    partitions.recordDevSnapshotOwner(pkg, "dev-200")
    expect(partitions.isDevSnapshotVisible(pkg, "dev-200")).toBe(true)
    stopRunning(pkg)
    expect(partitions.isDevSnapshotVisible(pkg, "dev-200")).toBe(false)
    partitions.setFleetWorkspace(session!, "ws_A")
    expect(partitions.isDevSnapshotVisible(pkg, "dev-200")).toBe(true)
  })

  test("a per-package switch interrupted midway finishes on the next sync", () => {
    const other = "com.acme.other"
    const store = mmkvInstances.get(partitions.MINIAPP_PARTITION_STORE_ID)!
    const from = store.getString("devsel.active")!
    const to = partitions.partitionIdOf({coreUrl: CORE, mentraUserId: "mu_1", workspaceId: "ws_B"})
    // other's live context holds A's selection; notes was stashed and the marker written before B's was restored.
    store.set(`devsel:${from}`, JSON.stringify({[`${pkg}_dev_url`]: "A's"}))
    store.set(`devsel:${to}`, JSON.stringify({[`${pkg}_dev_url`]: "B's", [`${other}_dev_url`]: "B's other"}))
    store.set("devsel.swap", JSON.stringify({to, packages: [pkg], held: {[other]: from}}))
    storage.save(`${pkg}_dev_url`, "half-written")
    storage.save(`${other}_dev_url`, "A's other")
    startRunning(other)
    store.set(`fleetws:${to.split(".").slice(0, 2).join(".")}`, "ws_B")
    partitions.syncDevelopmentSelections()
    expect(load(`${pkg}_dev_url`)).toBe("B's")
    expect(load(`${other}_dev_url`)).toBe("A's other")
    expect(store.getString("devsel.active")).toBe(to)
    stopRunning(other)
    expect(load(`${other}_dev_url`)).toBe("B's other")
    expect(JSON.parse(store.getString(`devsel:${from}`)!)).toEqual({
      [`${pkg}_dev_url`]: "A's",
      [`${other}_dev_url`]: "A's other",
    })
  })

  test("wait for a hidden context to stop before switching", () => {
    storage.save(`${pkg}_dev_url`, "http://192.168.1.5:5173")
    miniappContextRegistry.add(pkg)
    partitions.setFleetWorkspace(session!, "ws_B")
    expect(load(`${pkg}_dev_url`)).toBe("http://192.168.1.5:5173")
    miniappContextRegistry.remove(pkg)
    expect(load(`${pkg}_dev_url`)).toBeUndefined()
  })

  test("a switch interrupted midway finishes on the next sync", () => {
    storage.save(`${pkg}_dev_url`, "A's")
    const store = mmkvInstances.get(partitions.MINIAPP_PARTITION_STORE_ID)!
    const from = store.getString("devsel.active")!
    const to = partitions.partitionIdOf({coreUrl: CORE, mentraUserId: "mu_1", workspaceId: "ws_B"})
    // The process died after stashing A and writing the swap marker, before restoring B.
    store.set(`devsel:${from}`, JSON.stringify({[`${pkg}_dev_url`]: "A's"}))
    store.set(`devsel:${to}`, JSON.stringify({[`${pkg}_dev_url`]: "B's"}))
    store.set("devsel.swap", JSON.stringify({from, to}))
    storage.save(`${pkg}_dev_url`, "half-written")
    store.set(`fleetws:${to.split(".").slice(0, 2).join(".")}`, "ws_B")
    partitions.syncDevelopmentSelections()
    expect(load(`${pkg}_dev_url`)).toBe("B's")
    expect(store.getString("devsel.active")).toBe(to)
  })

  test("dev snapshots on disk belong to the context that installed them", () => {
    partitions.recordDevSnapshotOwner(pkg, "dev-100")
    expect(partitions.isDevSnapshotVisible(pkg, "dev-100")).toBe(true)
    partitions.setFleetWorkspace(session!, "ws_B")
    expect(partitions.isDevSnapshotVisible(pkg, "dev-100")).toBe(false)
    expect(partitions.isDevSnapshotVisible(pkg, "1.0.0")).toBe(true)
    partitions.setFleetWorkspace(session!, null)
    expect(partitions.isDevSnapshotVisible(pkg, "dev-100")).toBe(true)
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
