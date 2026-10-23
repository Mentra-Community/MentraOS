import {describe, expect, it, mock} from "bun:test"

import {fakeCreateMMKV} from "../fleet/__tests__/fakeMmkv"
import {LocalMiniappStorage, type LocalMiniappStorageBackend} from "../LocalMiniappStorage"
import type {MiniappDataContext, MiniappDataPartition} from "../miniappDataPartition"

mock.module("react-native-mmkv", () => ({createMMKV: fakeCreateMMKV}))
const {partitionIdOf} = await import("../miniappDataPartition")

class MemoryBackend implements LocalMiniappStorageBackend {
  readonly values = new Map<string, unknown>()

  get(key: string): unknown | null {
    return this.values.get(key) ?? null
  }

  has(key: string): boolean {
    return this.values.has(key)
  }

  set(key: string, value: unknown): void {
    this.values.set(key, value)
  }

  remove(key: string): void {
    this.values.delete(key)
  }

  keys(): string[] {
    return [...this.values.keys()]
  }
}

const CORE = "https://core.mentra.glass"

function partitionOf(context: MiniappDataContext): MiniappDataPartition {
  return {id: partitionIdOf(context), personalUserId: context.workspaceId ? null : context.mentraUserId}
}

function personal(mentraUserId: string, coreUrl = CORE) {
  return async () => partitionOf({coreUrl, mentraUserId, workspaceId: null})
}

function workspace(workspaceId: string, mentraUserId = "mu_1", coreUrl = CORE) {
  return async () => partitionOf({coreUrl, mentraUserId, workspaceId})
}

describe("LocalMiniappStorage", () => {
  it("survives a host restart because the namespace uses the stable user id", async () => {
    const backend = new MemoryBackend()
    const firstRuntime = new LocalMiniappStorage({backend, getPartition: personal("mu_123")})
    await firstRuntime.set("com.mentra.translation", "targetLanguage", "fr")

    // A new runtime represents a force-stopped/relaunched host. Its Core access
    // token will be different, but the identity exposed by CloudClient remains
    // the same Mentra user id.
    const restartedRuntime = new LocalMiniappStorage({backend, getPartition: personal("mu_123")})
    expect(await restartedRuntime.get("com.mentra.translation", "targetLanguage")).toBe("fr")
  })

  it("isolates values by user and package", async () => {
    const backend = new MemoryBackend()
    const userOne = new LocalMiniappStorage({backend, getPartition: personal("mu_1")})
    const userTwo = new LocalMiniappStorage({backend, getPartition: personal("mu_2")})

    await userOne.set("com.mentra.translation", "targetLanguage", "de")
    await userOne.set("com.mentra.captions", "targetLanguage", "en")

    expect(await userOne.get("com.mentra.translation", "targetLanguage")).toBe("de")
    expect(await userOne.get("com.mentra.captions", "targetLanguage")).toBe("en")
    expect(await userTwo.get("com.mentra.translation", "targetLanguage")).toBeNull()
  })

  it("isolates the same account id on another Core", async () => {
    const backend = new MemoryBackend()
    await new LocalMiniappStorage({backend, getPartition: personal("mu_1")}).set("com.acme.notes", "k", "prod")
    const otherCore = new LocalMiniappStorage({
      backend,
      getPartition: personal("mu_1", "https://core.dev.mentra.glass"),
    })
    expect(await otherCore.get("com.acme.notes", "k")).toBeNull()
    // Another spelling of the same Core is that Core.
    const sameCore = new LocalMiniappStorage({
      backend,
      getPartition: personal("mu_1", "HTTPS://Core.Mentra.Glass:443/"),
    })
    expect(await sameCore.get("com.acme.notes", "k")).toBe("prod")
  })

  it("keeps a workspace's private data apart from personal data and from another workspace", async () => {
    const backend = new MemoryBackend()
    const inA = new LocalMiniappStorage({backend, getPartition: workspace("ws_A")})
    const inB = new LocalMiniappStorage({backend, getPartition: workspace("ws_B")})
    const own = new LocalMiniappStorage({backend, getPartition: personal("mu_1")})
    await inA.set("com.acme.notes", "secret", "A only")

    expect(await inB.get("com.acme.notes", "secret")).toBeNull()
    expect(await inB.keys("com.acme.notes")).toEqual([])
    expect(await inB.getAll("com.acme.notes")).toEqual({})
    expect(await own.get("com.acme.notes", "secret")).toBeNull()
    // Clearing in B never reaches A's partition.
    await inB.clear("com.acme.notes")
    expect(await inA.get("com.acme.notes", "secret")).toBe("A only")
  })

  it("moves data from before partitions into the account's personal partition, once", async () => {
    const backend = new MemoryBackend()
    backend.set("mentraos_localstorage_mu_1_com.acme.notes_draft", "hello")
    backend.set("mentraos_localstorage_mu_2_com.acme.notes_draft", "someone else")

    const inWorkspace = new LocalMiniappStorage({backend, getPartition: workspace("ws_A")})
    expect(await inWorkspace.get("com.acme.notes", "draft")).toBeNull()

    const own = new LocalMiniappStorage({backend, getPartition: personal("mu_1")})
    expect(await own.get("com.acme.notes", "draft")).toBe("hello")
    expect(backend.has("mentraos_localstorage_mu_1_com.acme.notes_draft")).toBe(false)
    expect(backend.get("mentraos_localstorage_mu_2_com.acme.notes_draft")).toBe("someone else")

    // A key written under the old layout later (an old build) does not overwrite the partition.
    await own.set("com.acme.notes", "draft", "edited")
    backend.set("mentraos_localstorage_mu_1_com.acme.notes_draft", "stale")
    expect(await own.get("com.acme.notes", "draft")).toBe("edited")
  })

  it("refuses to create an anonymous namespace when identity is unavailable", async () => {
    const backend = new MemoryBackend()
    const storage = new LocalMiniappStorage({
      backend,
      getPartition: async () => {
        throw new Error("Mentra user identity is unavailable")
      },
    })

    await expect(storage.set("com.mentra.translation", "targetLanguage", "es")).rejects.toThrow(
      "Mentra user identity is unavailable",
    )
    expect(backend.keys()).toEqual([])
  })

  it("supports list, bulk read, delete, and clear within one scope", async () => {
    const backend = new MemoryBackend()
    const storage = new LocalMiniappStorage({backend, getPartition: personal("mu_123")})

    await storage.setMultiple("com.example.app", {alpha: "one", beta: "two", empty: null})
    expect((await storage.keys("com.example.app")).sort()).toEqual(["alpha", "beta", "empty"])
    expect(await storage.getAll("com.example.app")).toEqual({alpha: "one", beta: "two", empty: ""})
    expect(await storage.has("com.example.app", "alpha")).toBe(true)
    expect(await storage.has("com.example.app", "empty")).toBe(true)

    await storage.delete("com.example.app", "alpha")
    expect(await storage.has("com.example.app", "alpha")).toBe(false)
    await storage.clear("com.example.app")
    expect(await storage.keys("com.example.app")).toEqual([])
  })
})
