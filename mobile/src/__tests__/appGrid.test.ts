// Imports the real AppGrid computation by path (not via "@mentra/island", which
// jest mocks) so the actual algorithm runs under the mobile jest CI runner.
import {computeAppGrid} from "../../modules/island/src/services/AppGrid"
import type {ClientApp} from "../../modules/island/src/types/applet"

const app = (packageName: string, extra: Partial<ClientApp> = {}): ClientApp =>
  ({packageName, name: packageName, hidden: false, ...extra}) as ClientApp

const deps = {
  dummyApplet: app("@dummy"),
  sortByPriority: (a: ClientApp, b: ClientApp) => a.packageName.localeCompare(b.packageName),
}

const realPackages = (apps: ClientApp[]) =>
  apps.filter((a) => !a.packageName.startsWith("@empty")).map((a) => a.packageName)

describe("computeAppGrid", () => {
  it("does not mutate the input order map", () => {
    const orderMap = {"com.a": 0}
    const before = {...orderMap}
    computeAppGrid({apps: [app("com.a")], orderMap, showAllApps: false, searchQuery: ""}, deps)
    expect(orderMap).toEqual(before)
  })

  it("hides hidden apps unless showAllApps is set", () => {
    const apps = [app("com.a"), app("com.b", {hidden: true})]
    const home = computeAppGrid({apps, orderMap: {}, showAllApps: false}, deps)
    const all = computeAppGrid({apps, orderMap: {}, showAllApps: true}, deps)
    expect(realPackages(home.orderedApps)).toEqual(["com.a"])
    expect(realPackages(all.orderedApps).sort()).toEqual(["com.a", "com.b"])
  })

  it("applies the search filter to name and packageName", () => {
    const apps = [app("com.maps", {name: "Maps"}), app("com.notes", {name: "Notes"})]
    const res = computeAppGrid({apps, orderMap: {}, showAllApps: true, searchQuery: "map"}, deps)
    expect(realPackages(res.orderedApps)).toEqual(["com.maps"])
  })

  it("pads the grid with @empty placeholder slots around positioned apps", () => {
    // The grid only fills gaps once at least one app has a saved index — an
    // empty order map produces no placeholders (matches the original behavior).
    const res = computeAppGrid({apps: [app("com.a"), app("com.b")], orderMap: {"com.a": 2}, showAllApps: false}, deps)
    expect(res.orderedApps.some((a) => a.packageName.startsWith("@empty"))).toBe(true)
  })

  it("orders real apps by their saved order index", () => {
    const apps = [app("com.a"), app("com.b"), app("com.c")]
    const orderMap = {"com.c": 0, "com.a": 1, "com.b": 2}
    const res = computeAppGrid({apps, orderMap, showAllApps: false}, deps)
    expect(realPackages(res.orderedApps)).toEqual(["com.c", "com.a", "com.b"])
  })
})
