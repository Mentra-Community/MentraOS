import {deriveStoreUrl, selectStoreUrl} from "./storeUrl"

describe("Store endpoint derivation", () => {
  test("maps official service hosts to the matching Store environment", () => {
    expect(deriveStoreUrl("https://core.staging.us-west-2.mentraglass.com")).toBe(
      "https://store.staging.us-west-2.mentraglass.com",
    )
  })

  test("maps local Core port 3000 to Store port 3003", () => {
    expect(deriveStoreUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3003")
    expect(deriveStoreUrl("http://192.168.1.42:3000")).toBe("http://192.168.1.42:3003")
  })

  test("keeps non-conventional identity hosts on the same trusted origin", () => {
    expect(deriveStoreUrl("https://identity.example.test/cloud")).toBe("https://identity.example.test/cloud")
  })

  test("keeps a legacy custom Core profile ahead of the baked Store environment", () => {
    expect(
      selectStoreUrl({
        coreOverrideUrl: "https://identity.example.test/cloud",
        envStoreUrl: "https://store.mentraglass.com",
        resolvedCoreUrl: "https://identity.example.test/cloud",
      }),
    ).toBe("https://identity.example.test/cloud")
  })

  test("migrates a legacy Metro-host profile to the local Store port", () => {
    expect(
      selectStoreUrl({
        coreOverrideUrl: "http://192.168.1.42:3000",
        envStoreUrl: "https://store.mentraglass.com",
        resolvedCoreUrl: "http://192.168.1.42:3000",
      }),
    ).toBe("http://192.168.1.42:3003")
  })

  test("lets an explicit Store override win for independently named profiles", () => {
    expect(
      selectStoreUrl({
        storeOverrideUrl: "https://catalog.example.test",
        coreOverrideUrl: "https://identity.example.test",
        envStoreUrl: "https://store.mentraglass.com",
        resolvedCoreUrl: "https://identity.example.test",
      }),
    ).toBe("https://catalog.example.test")
  })
})
