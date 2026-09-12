import {describe, expect, test} from "bun:test"

import {resolveCloudEndpoints, scopeCloudUrlOverrides} from "../cloudEndpointPolicy"

describe("cloud endpoint selection", () => {
  test("honors explicit reconnect pins and resumes live host resolution after clearing", () => {
    let host = "192.0.2.10"
    const config = {resolveCloudEndpoints: () => ({core: `http://${host}:3000`, runtime: `http://${host}:3001`})}
    const pin = {core: "https://explicit.example", runtime: "https://explicit.example"}
    expect(resolveCloudEndpoints(config, pin)).toEqual({...pin, store: "https://explicit.example"})
    host = "192.0.2.11"
    expect(resolveCloudEndpoints(config, null)).toEqual({
      core: "http://192.0.2.11:3000",
      store: "http://192.0.2.11:3003",
      runtime: "http://192.0.2.11:3001",
    })
  })

  test("derives Store from Core unless the caller names one", () => {
    const config = {coreUrl: "https://core.example.test", runtimeUrl: "https://runtime.example.test"}
    expect(resolveCloudEndpoints(config, null).store).toBe("https://store.example.test")
    expect(resolveCloudEndpoints({...config, storeUrl: "https://pinned.example"}, null).store).toBe(
      "https://pinned.example",
    )
  })

  test("retains boot defaults for engine hosts without a live resolver", () => {
    // A Core-free deployment has no Store to derive either.
    expect(resolveCloudEndpoints({coreUrl: null, runtimeUrl: "https://runtime.example"}, null)).toEqual({
      runtime: "https://runtime.example",
    })
    expect(() => resolveCloudEndpoints({runtimeUrl: null}, null)).toThrow("Runtime endpoint is not configured")
  })
})

describe("partial debug URL updates", () => {
  test.each(["", "consumer", "workspace:other"])("drops stale siblings from scope %s", (scope) => {
    const current = {scope, core: "https://old-core.example", runtime: "https://old-runtime.example"}
    expect(scopeCloudUrlOverrides(current, "workspace:current", {core: "https://debug-core.example"})).toEqual({
      core: "https://debug-core.example",
      runtime: "",
    })
    expect(scopeCloudUrlOverrides(current, "workspace:current", {runtime: "https://debug-runtime.example"})).toEqual({
      core: "",
      runtime: "https://debug-runtime.example",
    })
  })

  test("preserves siblings within the same scope and for legacy consumer settings", () => {
    for (const scope of ["", "consumer"]) {
      expect(
        scopeCloudUrlOverrides({scope, runtime: "https://consumer-runtime.example"}, "consumer", {
          core: "https://debug.example",
        }),
      ).toEqual({core: "https://debug.example", runtime: "https://consumer-runtime.example"})
    }
    expect(
      scopeCloudUrlOverrides({scope: "workspace:a", runtime: "https://runtime.example"}, "workspace:a", {core: ""}),
    ).toEqual({core: "", runtime: "https://runtime.example"})
  })
})
