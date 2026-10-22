/// <reference types="bun-types" />
import {beforeEach, describe, expect, mock, test} from "bun:test"

import {fakeCreateMMKV, mmkvInstances, resetFakeMmkv} from "../fleet/__tests__/fakeMmkv"

mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))
const partitions = await import("../miniappDataPartition")
const {storage} = await import("../../utils/storage/storage")
const {miniappRunningRegistry} = await import("../MiniappRunningRegistry")

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

function load(key: string): unknown {
  const value = storage.load<unknown>(key)
  return value.is_ok() ? value.value : undefined
}

beforeEach(() => {
  for (const running of miniappRunningRegistry.getAll()) miniappRunningRegistry.remove(running)
  partitions.resetMiniappDataPartitionsForTests()
  resetFakeMmkv()
  session = {coreUrl: CORE, mentraUserId: "mu_1"}
  assigned.clear()
  configure()
})

describe("data partition of a package", () => {
  test("is the workspace's while that workspace assigned it, and personal otherwise", () => {
    const own = partitions.resolveMiniappDataPartition(pkg)
    expect(own.personalUserId).toBe("mu_1")
    assigned.set(pkg, "ws_A")
    const inA = partitions.resolveMiniappDataPartition(pkg)
    expect(inA.personalUserId).toBeNull()
    expect(inA.id).not.toBe(own.id)
    assigned.set(pkg, "ws_B")
    expect(partitions.resolveMiniappDataPartition(pkg).id).not.toBe(inA.id)
  })

  test("is safe as one file name, lower-case only", () => {
    session = {coreUrl: "https://Core.Example.com:8443/base/", mentraUserId: "User/../ID"}
    assigned.set(pkg, "WS.1")
    const {id} = partitions.resolveMiniappDataPartition(pkg)
    expect(id).toMatch(/^[a-z0-9_~.-]+$/)
    expect(id).not.toContain("..")
    expect(id.length).toBeLessThan(200)
  })

  test("changes only while the package is stopped", () => {
    assigned.set(pkg, "ws_A")
    miniappRunningRegistry.add(pkg)
    const running = partitions.resolveMiniappDataPartition(pkg).id
    // Leave A, join B while it runs: the running code keeps A's context.
    assigned.set(pkg, "ws_B")
    expect(partitions.resolveMiniappDataPartition(pkg).id).toBe(running)
    session = {coreUrl: CORE, mentraUserId: "mu_2"}
    expect(partitions.resolveMiniappDataPartition(pkg).id).toBe(running)
    miniappRunningRegistry.remove(pkg)
    const after = partitions.resolveMiniappDataPartition(pkg)
    expect(after.id).not.toBe(running)
    expect(after.id).toBe(partitions.partitionIdOf({coreUrl: CORE, mentraUserId: "mu_2", workspaceId: "ws_B"}))
  })

  test("is refused while no account is known", () => {
    session = null
    expect(() => partitions.resolveMiniappDataPartition(pkg)).toThrow("Mentra user identity is unavailable")
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
    miniappRunningRegistry.add(pkg)
    partitions.setFleetWorkspace(session!, "ws_B")
    expect(load(`${pkg}_dev_url`)).toBe("http://192.168.1.5:5173")
    miniappRunningRegistry.remove(pkg)
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
