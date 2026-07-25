import {describe, expect, it} from "bun:test"

import {LocalMiniappUserIdentity, type LocalMiniappUserIdentityBackend} from "../LocalMiniappUserIdentity"

class MemoryBackend implements LocalMiniappUserIdentityBackend {
  value: string | null = null

  get(): string | null {
    return this.value
  }

  set(userId: string): void {
    this.value = userId
  }

  remove(): void {
    this.value = null
  }
}

describe("LocalMiniappUserIdentity", () => {
  it("restores the stable user id without requiring an online token exchange", async () => {
    const backend = new MemoryBackend()
    backend.value = "mu_123"
    const identity = new LocalMiniappUserIdentity(backend)
    let onlineResolutionCalled = false

    const userId = await identity.resolve(async () => {
      onlineResolutionCalled = true
      throw new Error("offline")
    })

    expect(userId).toBe("mu_123")
    expect(onlineResolutionCalled).toBe(false)
  })

  it("persists an online identity for the next process", async () => {
    const backend = new MemoryBackend()
    const firstProcess = new LocalMiniappUserIdentity(backend)
    expect(await firstProcess.resolve(async () => "mu_123")).toBe("mu_123")

    const restartedProcess = new LocalMiniappUserIdentity(backend)
    expect(await restartedProcess.resolve(async () => "unreachable")).toBe("mu_123")
  })

  it("clears both memory and persistence on sign-out", async () => {
    const backend = new MemoryBackend()
    const identity = new LocalMiniappUserIdentity(backend)
    identity.remember("mu_123")
    identity.forget()

    await expect(identity.resolve(async () => "")).rejects.toThrow("Mentra user identity is unavailable")
    expect(backend.value).toBeNull()
  })
})
