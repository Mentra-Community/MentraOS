import {deriveStoreUrl} from "./storeUrl"

describe("Store endpoint derivation", () => {
  test("maps official service hosts to the matching Store environment", () => {
    expect(deriveStoreUrl("https://core.staging.us-west-2.mentraglass.com")).toBe(
      "https://store.staging.us-west-2.mentraglass.com",
    )
  })

  test("maps local Core port 3000 to Store port 3003", () => {
    expect(deriveStoreUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3003")
  })

  test("keeps non-conventional identity hosts on the same trusted origin", () => {
    expect(deriveStoreUrl("https://identity.example.test/cloud")).toBe("https://identity.example.test/cloud")
  })
})
