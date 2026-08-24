import {describe, expect, test} from "bun:test"
import {isNewerVersion, loadCompleteCatalog, parseCatalog, trustedCoreOrigin} from "./catalog"

const app = (packageName: string) => ({
  packageName,
  name: packageName,
  release: {
    id: `${packageName}-release`,
    version: "1.0.0",
    bundleUrl: `https://example.test/${packageName}.zip`,
    bundleSha256: "a".repeat(64),
  },
})

describe("Store catalog", () => {
  test("discards catalog-supplied host compatibility decisions", () => {
    const poisoned = app("com.example.poisoned") as ReturnType<typeof app> & {
      release: ReturnType<typeof app>["release"] & {installCompatibility?: unknown}
    }
    poisoned.release.installCompatibility = {
      compatible: false,
      blocker: "hardware",
      reason: "catalog says no",
    }
    expect(parseCatalog({apps: [poisoned]})[0]?.release.installCompatibility).toBeUndefined()
  })

  test("accepts only a safe host-provided Core origin", () => {
    expect(trustedCoreOrigin("https://core.dev.example.test/oauth")).toBe("https://core.dev.example.test")
    expect(trustedCoreOrigin("http://localhost:3000")).toBe("http://localhost:3000")
    expect(trustedCoreOrigin("http://192.168.1.42:3000/path")).toBe("http://192.168.1.42:3000")
    expect(trustedCoreOrigin("http://10.0.2.2:3000")).toBe("http://10.0.2.2:3000")
    expect(trustedCoreOrigin("http://[fd12:3456::1]:3000")).toBe("http://[fd12:3456::1]:3000")
    expect(trustedCoreOrigin("http://evil.example.test")).toBeNull()
    expect(trustedCoreOrigin("http://fd12.example.test:3000")).toBeNull()
    expect(trustedCoreOrigin("http://fe80.attacker.test:3000")).toBeNull()
    expect(trustedCoreOrigin("http://user:password@192.168.1.42:3000")).toBeNull()
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

  test("loads every catalog page and de-duplicates packages", async () => {
    const requested: number[] = []
    const apps = await loadCompleteCatalog(async (page) => {
      requested.push(page)
      return page === 1
        ? {apps: [app("com.example.one")], page: 1, hasMore: true}
        : {apps: [app("com.example.one"), app("com.example.two")], page: 2, hasMore: false}
    })

    expect(requested).toEqual([1, 2])
    expect(apps.map((item) => item.packageName)).toEqual(["com.example.one", "com.example.two"])
  })

  test("stops a catalog that claims endless pages", async () => {
    await expect(loadCompleteCatalog(async (page) => ({apps: [], page, hasMore: true}), 2)).rejects.toThrow(
      "safety limit",
    )
  })

  test("offers only strict semantic-version upgrades", () => {
    expect(isNewerVersion("1.1.0", "1.0.9")).toBe(true)
    expect(isNewerVersion("2.0.0", "2.0.0-beta.2")).toBe(true)
    expect(isNewerVersion("1.9.9", "2.0.0")).toBe(false)
    expect(isNewerVersion("latest", "1.0.0")).toBe(false)
    expect(isNewerVersion("1.0.0-9007199254740993", "1.0.0-9007199254740992")).toBe(true)
    expect(isNewerVersion("1.0.0-01", "1.0.0-1")).toBe(false)
  })
})
