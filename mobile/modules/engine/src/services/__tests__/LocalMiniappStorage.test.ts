import {describe, expect, it} from "bun:test"

import {LocalMiniappStorage, type LocalMiniappStorageBackend} from "../LocalMiniappStorage"

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

describe("LocalMiniappStorage", () => {
  it("survives a host restart because the namespace uses the stable user id", async () => {
    const backend = new MemoryBackend()
    const firstRuntime = new LocalMiniappStorage({backend, getUserId: async () => "mu_123"})
    await firstRuntime.set("com.mentra.translation", "targetLanguage", "fr")

    // A new runtime represents a force-stopped/relaunched host. Its Core access
    // token will be different, but the identity exposed by CloudClient remains
    // the same Mentra user id.
    const restartedRuntime = new LocalMiniappStorage({backend, getUserId: async () => "mu_123"})
    expect(await restartedRuntime.get("com.mentra.translation", "targetLanguage")).toBe("fr")
  })

  it("isolates values by user and package", async () => {
    const backend = new MemoryBackend()
    const userOne = new LocalMiniappStorage({backend, getUserId: async () => "mu_1"})
    const userTwo = new LocalMiniappStorage({backend, getUserId: async () => "mu_2"})

    await userOne.set("com.mentra.translation", "targetLanguage", "de")
    await userOne.set("com.mentra.captions", "targetLanguage", "en")

    expect(await userOne.get("com.mentra.translation", "targetLanguage")).toBe("de")
    expect(await userOne.get("com.mentra.captions", "targetLanguage")).toBe("en")
    expect(await userTwo.get("com.mentra.translation", "targetLanguage")).toBeNull()
  })

  it("refuses to create an anonymous namespace when identity is unavailable", async () => {
    const backend = new MemoryBackend()
    const storage = new LocalMiniappStorage({backend, getUserId: async () => ""})

    await expect(storage.set("com.mentra.translation", "targetLanguage", "es")).rejects.toThrow(
      "Mentra user identity is unavailable",
    )
    expect(backend.keys()).toEqual([])
  })

  it("migrates the newest values from this user's legacy token namespaces", async () => {
    const backend = new MemoryBackend()
    const oldToken = testAccessToken("mu_123", 100)
    const newToken = testAccessToken("mu_123", 200)
    const otherUserToken = testAccessToken("mu_other", 300)
    backend.set(`mentraos_localstorage_${oldToken}_com.mentra.translation_targetLanguage`, "es")
    backend.set(`mentraos_localstorage_${oldToken}_com.mentra.translation_displayLines`, "3")
    backend.set(`mentraos_localstorage_${newToken}_com.mentra.translation_targetLanguage`, "fr")
    backend.set(`mentraos_localstorage_${otherUserToken}_com.mentra.translation_targetLanguage`, "de")

    const storage = new LocalMiniappStorage({backend, getUserId: async () => "mu_123"})
    expect(await storage.getAll("com.mentra.translation")).toEqual({targetLanguage: "fr", displayLines: "3"})
    expect(backend.keys().some((key) => key.includes(oldToken) || key.includes(newToken))).toBe(false)
    expect(backend.keys().some((key) => key.includes(otherUserToken))).toBe(true)
  })

  it("does not overwrite a stable value with legacy data", async () => {
    const backend = new MemoryBackend()
    const oldToken = testAccessToken("mu_123", 100)
    backend.set(`mentraos_localstorage_${oldToken}_com.mentra.translation_targetLanguage`, "es")
    backend.set("mentraos_localstorage_mu_123_com.mentra.translation_targetLanguage", "ja")

    const storage = new LocalMiniappStorage({backend, getUserId: async () => "mu_123"})
    expect(await storage.get("com.mentra.translation", "targetLanguage")).toBe("ja")
    expect(backend.keys().some((key) => key.includes(oldToken))).toBe(false)
  })

  it("supports list, bulk read, delete, and clear within one scope", async () => {
    const backend = new MemoryBackend()
    const storage = new LocalMiniappStorage({backend, getUserId: async () => "mu_123"})

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

function testAccessToken(userId: string, issuedAt: number): string {
  const payload = btoa(JSON.stringify({sub: userId, iat: issuedAt}))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
  return `header.${payload}.signature`
}
