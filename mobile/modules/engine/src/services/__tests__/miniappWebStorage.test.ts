/// <reference types="bun-types" />
import {beforeEach, describe, expect, mock, spyOn, test} from "bun:test"

import {DEFAULT_MMKV_ID, fakeCreateMMKV, mmkvInstances, resetFakeMmkv} from "../fleet/__tests__/fakeMmkv"

mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))
const web = await import("../miniappWebStorage")
const {partitionIdOf} = await import("../miniappDataPartition")
const {storage} = await import("../../utils/storage/storage")

const CORE = "https://core.mentra.glass"
const ACME = "com.acme.journal"
const OTHER = "com.other.diary"
const originOf = (packageName: string) => `miniapp://${packageName}`
const personal = (mentraUserId: string) => partitionIdOf({coreUrl: CORE, mentraUserId, workspaceId: null})

function open(packageName: string, partitionId: string, origin = originOf(packageName), rememberRemoved?: string[]) {
  return web.openMiniappWebStorage({packageName, origin, partitionId, rememberRemoved})
}

/** One load of the screen: open, then the keeper reports it ran. */
function load(packageName: string, partitionId: string, origin = originOf(packageName)) {
  const session = open(packageName, partitionId, origin)
  web.markMiniappWebStorageLoaded(session)
  return session
}

beforeEach(() => {
  resetFakeMmkv()
  web.resetMiniappWebStorageForTests()
})

describe("the host's copy of a screen's localStorage", () => {
  test("keeps every key the page writes, so a load after WebKit deletes the origin's storage gets them back", () => {
    const first = load(ACME, personal("mu_1"))
    expect(first.mode).toBe("merge")
    web.applyMiniappWebStorageOps(first, [
      ["set", "draft", "Dear diary"],
      ["set", "theme", "dark"],
      ["set", "lib:cache", "{}"],
    ])
    // WebKit's deletion happens in the WebView; the copy is the host's. A new WebView merges it back.
    const next = open(ACME, personal("mu_1"))
    expect(next.mode).toBe("merge")
    expect(next.copyId).toBe(first.copyId)
    expect(web.miniappWebStorageEntries(next)).toEqual({"draft": "Dear diary", "theme": "dark", "lib:cache": "{}"})
  })

  test("follows removeItem and clear, so removed keys stay removed", () => {
    const session = load(ACME, personal("mu_1"))
    web.applyMiniappWebStorageOps(session, [
      ["set", "a", "1"],
      ["set", "b", "2"],
      ["remove", "a"],
    ])
    expect(web.miniappWebStorageEntries(open(ACME, personal("mu_1")))).toEqual({b: "2"})
    web.applyMiniappWebStorageOps(session, [["clear"], ["set", "c", "3"]])
    expect(web.miniappWebStorageEntries(open(ACME, personal("mu_1")))).toEqual({c: "3"})
  })

  test("keeps each package's copy to itself, and each account's and local build's apart", () => {
    web.applyMiniappWebStorageOps(load(ACME, personal("mu_1")), [["set", "secret", "acme"]])
    expect(web.miniappWebStorageEntries(open(OTHER, personal("mu_1")))).toEqual({})
    expect(web.miniappWebStorageEntries(open(ACME, personal("mu_2")))).toEqual({})
    const local = partitionIdOf({coreUrl: CORE, mentraUserId: "mu_1", workspaceId: null, localBuild: true})
    expect(local).not.toBe(personal("mu_1"))
    expect(web.miniappWebStorageEntries(open(ACME, local))).toEqual({})
    const workspace = partitionIdOf({coreUrl: CORE, mentraUserId: "mu_1", workspaceId: "ws_A"})
    expect(web.miniappWebStorageEntries(open(ACME, workspace))).toEqual({})
    expect(web.miniappWebStorageEntries(open(ACME, personal("mu_1")))).toEqual({secret: "acme"})
  })

  test("replaces the origin's storage when it holds another account's or workspace's copy", () => {
    web.applyMiniappWebStorageOps(load(ACME, personal("mu_1")), [["set", "who", "one"]])
    // Another account on the phone opens the same miniapp: the origin holds mu_1's copy.
    const second = open(ACME, personal("mu_2"))
    expect(second.mode).toBe("replace")
    web.markMiniappWebStorageLoaded(second)
    expect(open(ACME, personal("mu_2")).mode).toBe("merge")
    // And back: the origin now holds mu_2's copy.
    expect(open(ACME, personal("mu_1")).mode).toBe("replace")
  })

  test("replaces an origin a newer copy was loaded elsewhere since (a development snapshot and its live server)", () => {
    const local = partitionIdOf({coreUrl: CORE, mentraUserId: "mu_1", workspaceId: null, localBuild: true})
    const snapshot = "miniapp://invalid.dev.com.acme.journal"
    const server = "http://192.168.1.20:8081"
    load(ACME, local, snapshot)
    const live = load(ACME, local, server)
    web.applyMiniappWebStorageOps(live, [["set", "draft", "newer"]])
    // The snapshot's origin still holds the older values; the copy is the newer.
    expect(open(ACME, local, snapshot).mode).toBe("replace")
  })

  test("merges the first time, so an origin's existing storage is adopted rather than wiped", () => {
    expect(open(ACME, personal("mu_1")).mode).toBe("merge")
    // An origin whose screen ran while no account was known is replaced at its next load.
    web.markMiniappWebStorageOriginUnknown(originOf(OTHER))
    expect(open(OTHER, personal("mu_1")).mode).toBe("replace")
  })

  test("an origin whose screen never confirmed its load is replaced, not adopted, after a logout", () => {
    const session = open(ACME, personal("mu_1")) // the screen's "loaded" report never arrives
    web.applyMiniappWebStorageOps(session, [["set", "draft", "private"]])
    storage.clearAll()
    expect(open(ACME, personal("mu_2")).mode).toBe("replace")
  })

  test("keeps at most 5 MB per package; a write that doesn't fit isn't kept, and its key drops out", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    const session = load(ACME, personal("mu_1"))
    const half = "x".repeat(web.MINIAPP_WEB_STORAGE_CAP_BYTES / 4 - 10) // 2 bytes per code unit
    web.applyMiniappWebStorageOps(session, [
      ["set", "a", half],
      ["set", "small", "old"],
    ])
    const result = web.applyMiniappWebStorageOps(session, [
      ["set", "b", half],
      ["set", "small", `${half}more`],
    ])
    expect(result.notKept).toEqual(["small"])
    const kept = web.miniappWebStorageEntries(open(ACME, personal("mu_1")))
    expect(Object.keys(kept).sort()).toEqual(["a", "b"])
    // Removing makes room again.
    web.applyMiniappWebStorageOps(session, [
      ["remove", "a"],
      ["set", "small", "fits"],
    ])
    expect(web.miniappWebStorageEntries(open(ACME, personal("mu_1")))).toEqual({b: half, small: "fits"})
    // Another package has a cap of its own.
    expect(web.applyMiniappWebStorageOps(load(OTHER, personal("mu_1")), [["set", "a", half]]).notKept).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  test("logout's clearAll clears the copy, and the origin's storage is replaced at the next load", () => {
    const session = load(ACME, personal("mu_1"))
    web.applyMiniappWebStorageOps(session, [["set", "draft", "private"]])
    storage.clearAll() // LogoutUtils: the default MMKV instance, where SDK storage lives too
    expect(mmkvInstances.get(DEFAULT_MMKV_ID)!.getAllKeys()).toEqual([])
    // The same account signs in again: an empty copy, and the origin is cleared rather than adopted.
    const again = open(ACME, personal("mu_1"))
    expect(again.mode).toBe("replace")
    expect(web.miniappWebStorageEntries(again)).toEqual({})
    // A report from the screen of before the logout changes nothing.
    web.applyMiniappWebStorageOps(session, [["set", "draft", "late"]])
    expect(web.miniappWebStorageEntries(again)).toEqual({})
  })

  test("treats any key as a key, __proto__ included", () => {
    const session = load(ACME, personal("mu_1"))
    web.applyMiniappWebStorageOps(session, [
      ["set", "__proto__", "p"],
      ["set", "constructor", "c"],
    ])
    web.resetMiniappWebStorageForTests() // read back from storage, not the cache
    const kept = web.miniappWebStorageEntries(open(ACME, personal("mu_1")))
    expect(Object.getOwnPropertyDescriptor(kept, "__proto__")?.value).toBe("p")
    expect(Object.keys(kept).sort()).toEqual(["__proto__", "constructor"])
  })

  test("lives beside the package's SDK storage, in its data partition", () => {
    const session = load(ACME, personal("mu_1"))
    web.applyMiniappWebStorageOps(session, [["set", "k", "v"]])
    const keys = mmkvInstances.get(DEFAULT_MMKV_ID)!.getAllKeys()
    expect(keys).toContain(`mentraos_miniappwebstorage/${personal("mu_1")}/${ACME}/entries`)
    // Nothing under SDK storage's own namespace, so session.storage.keys() never lists these.
    expect(keys.some((key) => key.startsWith("mentraos_miniappdata/"))).toBe(false)
  })
})

describe("moving data the package kept elsewhere", () => {
  test("fills only keys the copy knows nothing about, and never brings back a remembered removal", () => {
    const listed = ["onboarding", "recent", "drawer"]
    const session = web.openMiniappWebStorage({
      packageName: ACME,
      origin: originOf(ACME),
      partitionId: personal("mu_1"),
      rememberRemoved: listed,
    })
    web.applyMiniappWebStorageOps(session, [
      ["set", "recent", "newer"],
      ["set", "onboarding", "x"],
      ["remove", "onboarding"],
    ])
    expect(web.removedMiniappWebStorageKeys(session)).toEqual(["onboarding"])
    web.fillMiniappWebStorage(session, {onboarding: "old", recent: "old", drawer: "old"}, [])
    expect(web.miniappWebStorageEntries(session)).toEqual({recent: "newer", drawer: "old"})
    // Removals the earlier store remembered are remembered too (only for listed keys).
    web.fillMiniappWebStorage(session, {}, ["drawer", "unlisted"])
    expect(web.removedMiniappWebStorageKeys(session)).toEqual(["onboarding"])
    const fresh = web.openMiniappWebStorage({
      packageName: OTHER,
      origin: originOf(OTHER),
      partitionId: personal("mu_1"),
      rememberRemoved: ["drawer"],
    })
    web.fillMiniappWebStorage(fresh, {}, ["drawer", "unlisted"])
    expect(web.removedMiniappWebStorageKeys(fresh)).toEqual(["drawer"])
    web.fillMiniappWebStorage(fresh, {drawer: "back?"})
    expect(web.miniappWebStorageEntries(fresh)).toEqual({})
    // A later write by the page is kept as usual.
    web.applyMiniappWebStorageOps(fresh, [["set", "drawer", "new"]])
    expect(web.miniappWebStorageEntries(fresh)).toEqual({drawer: "new"})
    expect(web.removedMiniappWebStorageKeys(fresh)).toEqual([])
  })
})
