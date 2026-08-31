import {describe, expect, test} from "bun:test"

import {mintCoreDownloadAuthorization, resolveCoreDownloadAuthorization} from "../CoreDownloadAuthorization"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return {promise, resolve}
}

describe("resolveCoreDownloadAuthorization", () => {
  test("uses the reconnect-selected Store origin instead of the boot origin", async () => {
    let activeCoreUrl = "https://boot.example.com"
    let activeStoreUrl = "https://boot-store.example.com"
    const provider = {
      getCoreUrl: () => activeCoreUrl,
      getStoreUrl: () => activeStoreUrl,
      getCoreDownloadAuthorization: async () => ({
        origin: new URL(activeCoreUrl).origin,
        bearerToken: "core-token",
      }),
    }

    activeCoreUrl = "https://override.example.com/api"
    activeStoreUrl = "https://override-store.example.com/api"
    await expect(
      resolveCoreDownloadAuthorization("https://override-store.example.com/api/store/bundles/asset/download", provider),
    ).resolves.toEqual({origin: "https://override-store.example.com", bearerToken: "core-token"})
  })

  test("uses the host-resolved local Store fallback", async () => {
    const provider = {
      getCoreUrl: () => "http://localhost:3000",
      getStoreUrl: () => "http://localhost:3003",
      getCoreDownloadAuthorization: async () => ({
        origin: "http://localhost:3000",
        bearerToken: "local-core-token",
      }),
    }

    await expect(
      resolveCoreDownloadAuthorization("http://localhost:3003/api/store/bundles/asset/download", provider),
    ).resolves.toEqual({origin: "http://localhost:3003", bearerToken: "local-core-token"})
  })

  test("does not mint or attach Core credentials for an external bundle origin", async () => {
    let tokenRequests = 0
    const provider = {
      getCoreUrl: () => "https://core.example.com",
      getStoreUrl: () => "https://store.example.com",
      getCoreDownloadAuthorization: async () => {
        tokenRequests += 1
        return {origin: "https://core.example.com", bearerToken: "core-token"}
      },
    }

    await expect(
      resolveCoreDownloadAuthorization("https://oem-store.example.com/bundle.zip", provider),
    ).resolves.toBeUndefined()
    expect(tokenRequests).toBe(0)
  })

  test("fails closed if Core changes while the credential is being minted", async () => {
    let activeCoreUrl = "https://first.example.com"
    const provider = {
      getCoreUrl: () => activeCoreUrl,
      getStoreUrl: () => "https://store.example.com",
      getCoreDownloadAuthorization: async () => {
        activeCoreUrl = "https://second.example.com"
        return {origin: "https://second.example.com", bearerToken: "core-token"}
      },
    }

    await expect(
      resolveCoreDownloadAuthorization("https://store.example.com/api/store/bundles/asset/download", provider),
    ).rejects.toThrow("Core endpoint changed while authorizing bundle download")
  })

  test("never relabels a token when the Cloud client reconnects during minting", async () => {
    const oldToken = deferred<string>()
    const oldClient = {name: "old"}
    const newClient = {name: "new"}
    let snapshot = {
      client: oldClient,
      origin: "https://old-core.example.com",
      getBearerToken: () => oldToken.promise,
    }

    const pending = mintCoreDownloadAuthorization(() => snapshot)
    snapshot = {
      client: newClient,
      origin: "https://oem-core.example.com",
      getBearerToken: async () => "new-token",
    }
    oldToken.resolve("old-token")

    await expect(pending).rejects.toThrow("Core endpoint changed while minting bundle authorization")
    await expect(mintCoreDownloadAuthorization(() => snapshot)).resolves.toEqual({
      origin: "https://oem-core.example.com",
      bearerToken: "new-token",
    })
  })
})
