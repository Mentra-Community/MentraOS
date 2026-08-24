import {describe, expect, test} from "bun:test"

import {isManagedByStore, type InstalledApp} from "./types"

const installed: InstalledApp = {
  packageName: "com.example.app",
  name: "Example",
  version: "1.0.0",
  running: false,
  compatibility: {isCompatible: true, warnings: []},
}

describe("Store release ownership", () => {
  test("allows only the Store that installed the active release to remove it", () => {
    const owned = {...installed, storeOwnerPackageName: "com.mentra.store"}
    expect(isManagedByStore(owned, "com.mentra.store")).toBe(true)
    expect(isManagedByStore(owned, "com.some-oem.store")).toBe(false)
  })

  test("does not treat bundled or directly installed packages as Store-owned", () => {
    expect(isManagedByStore(installed, "com.mentra.store")).toBe(false)
  })
})
