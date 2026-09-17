/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import type {ClientApp} from "../../types/applet"
import {runAppsRefresh} from "../appsRefresh"

function makeApp(packageName: string): ClientApp {
  return {
    packageName,
    name: packageName,
    webviewUrl: "",
    logoUrl: "",
    type: "standard",
    permissions: [],
    running: false,
    healthy: true,
    hardwareRequirements: [],
    offline: false,
    offlineRoute: "",
    loading: false,
    local: true,
    hidden: false,
  }
}

describe("runAppsRefresh (#1222)", () => {
  test("on success: projects the fetched apps, saves the cache, and reports no error", async () => {
    const fetched = [makeApp("com.example.a")]
    const projected = [makeApp("com.example.a-projected")]
    const saved: ClientApp[][] = []

    const result = await runAppsRefresh(
      async () => fetched,
      (apps) => {
        expect(apps).toBe(fetched)
        return projected
      },
      (apps) => saved.push(apps),
    )

    expect(result.apps).toBe(projected)
    expect(result.refreshError).toBeNull()
    expect(saved).toEqual([projected])
  })

  test("a fetch failure is captured as refreshError, apps is omitted, and nothing is cached", async () => {
    const saved: ClientApp[][] = []

    const result = await runAppsRefresh(
      async () => {
        throw new Error("disk unavailable")
      },
      (apps) => apps,
      (apps) => saved.push(apps),
    )

    expect(result.apps).toBeUndefined()
    expect(result.refreshError).toBe("disk unavailable")
    expect(saved).toEqual([])
  })

  test("a project() failure is also captured (not just the fetch)", async () => {
    const result = await runAppsRefresh(
      async () => [],
      () => {
        throw new Error("projectApps blew up")
      },
      () => {},
    )

    expect(result.apps).toBeUndefined()
    expect(result.refreshError).toBe("projectApps blew up")
  })

  test("a non-Error throw is stringified rather than dropped", async () => {
    const result = await runAppsRefresh(
      async () => {
        throw "just a string"
      },
      (apps) => apps,
      () => {},
    )

    expect(result.refreshError).toBe("just a string")
  })
})
