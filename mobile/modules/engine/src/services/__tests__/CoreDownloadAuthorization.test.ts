import {describe, expect, test} from "bun:test"

import {resolveCoreDownloadAuthorization} from "../CoreDownloadAuthorization"

describe("resolveCoreDownloadAuthorization", () => {
  test("uses the reconnect-selected Core origin instead of the boot origin", async () => {
    let activeCoreUrl = "https://boot.example.com"
    const provider = {
      getCoreUrl: () => activeCoreUrl,
      getCoreDownloadAuthorization: async () => ({
        origin: new URL(activeCoreUrl).origin,
        bearerToken: "core-token",
      }),
    }

    activeCoreUrl = "https://override.example.com/api"
    await expect(
      resolveCoreDownloadAuthorization("https://override.example.com/api/store/bundles/asset/download", provider),
    ).resolves.toEqual({origin: "https://override.example.com", bearerToken: "core-token"})
  })

  test("uses the host-resolved local Core fallback", async () => {
    const provider = {
      getCoreUrl: () => "http://localhost:3000",
      getCoreDownloadAuthorization: async () => ({
        origin: "http://localhost:3000",
        bearerToken: "local-core-token",
      }),
    }

    await expect(
      resolveCoreDownloadAuthorization("http://localhost:3000/api/store/bundles/asset/download", provider),
    ).resolves.toEqual({origin: "http://localhost:3000", bearerToken: "local-core-token"})
  })

  test("does not mint or attach Core credentials for an external bundle origin", async () => {
    let tokenRequests = 0
    const provider = {
      getCoreUrl: () => "https://core.example.com",
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
      getCoreDownloadAuthorization: async () => {
        activeCoreUrl = "https://second.example.com"
        return {origin: "https://second.example.com", bearerToken: "core-token"}
      },
    }

    await expect(
      resolveCoreDownloadAuthorization("https://first.example.com/api/store/bundles/asset/download", provider),
    ).rejects.toThrow("Core endpoint changed while authorizing bundle download")
  })
})
