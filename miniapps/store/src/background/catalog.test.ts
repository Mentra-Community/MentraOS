import {describe, expect, test} from "bun:test"
import {coreOriginFromToken, isNewerVersion, parseCatalog} from "./catalog"

function token(payload: object) {
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `header.${encoded}.signature`
}

describe("Store catalog", () => {
  test("derives the current Core origin from the scoped token issuer", () => {
    expect(coreOriginFromToken(token({iss: "https://core.dev.example.test/oauth"}))).toBe(
      "https://core.dev.example.test",
    )
    expect(coreOriginFromToken(token({iss: "http://evil.example.test"}))).toBeNull()
  })

  test("keeps only installable catalog entries", () => {
    const apps = parseCatalog({
      apps: [
        {
          packageName: "com.example.good",
          name: "Good",
          release: {
            id: "r1",
            version: "1.0.0",
            bundleUrl: "https://example.test/bundle.zip",
            bundleSha256: "a".repeat(64),
          },
        },
        {
          packageName: "com.example.bad",
          name: "Bad",
          release: {id: "r2", version: "1.0.0", bundleUrl: "https://example.test/bundle.zip", bundleSha256: "nope"},
        },
      ],
    })
    expect(apps.map((app) => app.packageName)).toEqual(["com.example.good"])
  })

  test("rejects a malformed response", () => {
    expect(() => parseCatalog({items: []})).toThrow("invalid response")
  })

  test("offers only strict semantic-version upgrades", () => {
    expect(isNewerVersion("1.1.0", "1.0.9")).toBe(true)
    expect(isNewerVersion("2.0.0", "2.0.0-beta.2")).toBe(true)
    expect(isNewerVersion("1.9.9", "2.0.0")).toBe(false)
    expect(isNewerVersion("latest", "1.0.0")).toBe(false)
  })
})
