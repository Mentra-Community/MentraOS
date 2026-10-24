import {describe, expect, test} from "bun:test"
import {
  installedPortalModules,
  portalModuleAccess,
  portalModuleAvailability,
  portalModuleConfig,
  portalModulePublicAccess,
  type ConfigLog,
  type PortalModuleName,
} from "./portal-modules"

const SECRET = "billing-shared-secret-value"
/** Every value `CLOUD_CORE_ENVIRONMENT` takes, unset included: none of them changes who reaches a module. */
const ENVIRONMENTS = ["prod", "staging", "dev", "production", "local", "", undefined]

/** A logger that records what it is given, so a misconfiguration is asserted rather than printed. */
function recordingLog(): ConfigLog & {lines: Array<{variable: unknown; message: string}>} {
  const lines: Array<{variable: unknown; message: string}> = []
  return {
    lines,
    error: ((fields: {variable?: unknown}, message?: string) => {
      lines.push({variable: fields.variable, message: message ?? ""})
    }) as ConfigLog["error"],
  }
}

const env = (values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({...values})
const hosted = (url: string, extra: Record<string, string | undefined> = {}) =>
  env({CLOUD_CORE_BILLING_URL: url, CLOUD_CORE_BILLING_SECRET: SECRET, CLOUD_CORE_ENVIRONMENT: "prod", ...extra})

describe("portalModuleConfig", () => {
  test("is not installed without a URL, whatever else is set", () => {
    expect(portalModuleConfig("billing", env())).toEqual({state: "not_installed"})
    expect(portalModuleConfig("billing", env({CLOUD_CORE_BILLING_URL: ""}))).toEqual({state: "not_installed"})
    expect(portalModuleConfig("billing", env({CLOUD_CORE_BILLING_URL: "   "}))).toEqual({state: "not_installed"})
    // A secret alone is inert.
    expect(portalModuleConfig("billing", env({CLOUD_CORE_BILLING_SECRET: SECRET}))).toEqual({state: "not_installed"})
  })

  test("is ready with a usable URL and a secret, and keeps the URL's path prefix", () => {
    const config = portalModuleConfig("billing", hosted("  https://store.example.test/billing  "))
    expect(config.state).toBe("ready")
    if (config.state !== "ready") throw new Error("not ready")
    expect(config.baseUrl.href).toBe("https://store.example.test/billing")
    expect(config.secret).toBe(SECRET)
  })

  test("is misconfigured, naming the variable and never its value, when the URL is unusable or the secret missing", () => {
    for (const values of [
      {CLOUD_CORE_BILLING_URL: "ftp://store.example.test", CLOUD_CORE_BILLING_SECRET: SECRET},
      {CLOUD_CORE_BILLING_URL: "https://user:pass@store.example.test", CLOUD_CORE_BILLING_SECRET: SECRET},
      {CLOUD_CORE_BILLING_URL: "https://store.example.test/?q=1", CLOUD_CORE_BILLING_SECRET: SECRET},
      {CLOUD_CORE_BILLING_URL: "not a url", CLOUD_CORE_BILLING_SECRET: SECRET},
    ]) {
      const log = recordingLog()
      const config = portalModuleConfig("billing", env(values), log)
      expect(config.state).toBe("misconfigured")
      expect(config.state === "misconfigured" && config.reason).toContain("CLOUD_CORE_BILLING_URL")
      expect(JSON.stringify(config)).not.toContain(SECRET)
      expect(JSON.stringify(config)).not.toContain("user:pass")
      expect(log.lines.map(line => line.variable)).toEqual(["CLOUD_CORE_BILLING_URL"])
      expect(JSON.stringify(log.lines)).not.toContain(SECRET)
      expect(JSON.stringify(log.lines)).not.toContain("user:pass")
    }
    for (const secret of [undefined, "", "   "]) {
      const log = recordingLog()
      const config = portalModuleConfig(
        "billing",
        env({CLOUD_CORE_BILLING_URL: "https://store.example.test", CLOUD_CORE_BILLING_SECRET: secret}),
        log,
      )
      expect(config.state).toBe("misconfigured")
      expect(config.state === "misconfigured" && config.reason).toContain("CLOUD_CORE_BILLING_SECRET")
      expect(log.lines.map(line => line.variable)).toEqual(["CLOUD_CORE_BILLING_SECRET"])
    }
  })

  test("reports a problem once per logger, so a request path that asks again stays quiet", () => {
    const log = recordingLog()
    const broken = env({CLOUD_CORE_BILLING_URL: "ftp://store.example.test", CLOUD_CORE_BILLING_SECRET: SECRET})
    for (let asked = 0; asked < 3; asked++) portalModuleConfig("billing", broken, log)
    expect(log.lines).toHaveLength(1)
    // Another logger is told again: one test's report does not use up another's.
    const other = recordingLog()
    portalModuleConfig("billing", broken, other)
    expect(other.lines).toHaveLength(1)
  })

  test("plain http is for a local or test Core, and for localhost only on a deployed one", () => {
    const url = "http://store.internal:8080"
    const log = recordingLog()
    expect(portalModuleConfig("billing", env({CLOUD_CORE_BILLING_URL: url, CLOUD_CORE_BILLING_SECRET: SECRET}), log).state).toBe("ready")
    for (const deployment of [{CLOUD_CORE_ENVIRONMENT: "prod"}, {CLOUD_CORE_ENVIRONMENT: "staging"}, {NODE_ENV: "production"}]) {
      const config = portalModuleConfig("billing", env({CLOUD_CORE_BILLING_URL: url, CLOUD_CORE_BILLING_SECRET: SECRET, ...deployment}), log)
      expect(config.state).toBe("misconfigured")
    }
    for (const local of ["http://localhost:8080", "http://127.0.0.1:8080/billing"]) {
      expect(portalModuleConfig("billing", hosted(local)).state).toBe("ready")
    }
  })

  test("reads the process environment when it is given none", () => {
    const saved = {
      url: process.env.CLOUD_CORE_BILLING_URL,
      secret: process.env.CLOUD_CORE_BILLING_SECRET,
    }
    try {
      process.env.CLOUD_CORE_BILLING_URL = "https://store.example.test"
      process.env.CLOUD_CORE_BILLING_SECRET = SECRET
      expect(portalModuleConfig("billing").state).toBe("ready")
      delete process.env.CLOUD_CORE_BILLING_URL
      expect(portalModuleConfig("billing").state).toBe("not_installed")
    } finally {
      for (const [name, value] of [["CLOUD_CORE_BILLING_URL", saved.url], ["CLOUD_CORE_BILLING_SECRET", saved.secret]] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})

describe("portalModuleAccess", () => {
  const url = "https://store.example.test"

  test("is hidden when the module is not installed, on every Core", () => {
    for (const environment of ENVIRONMENTS) {
      expect([environment, portalModuleAccess("billing", env({CLOUD_CORE_ENVIRONMENT: environment}))]).toEqual([environment, {state: "hidden"}])
      // A secret alone is inert.
      const secretOnly = env({CLOUD_CORE_ENVIRONMENT: environment, CLOUD_CORE_BILLING_SECRET: SECRET})
      expect([environment, portalModuleAccess("billing", secretOnly)]).toEqual([environment, {state: "hidden"}])
    }
  })

  test("is unavailable when the module is installed with settings Core cannot use", () => {
    for (const environment of ENVIRONMENTS) {
      const broken = hosted("ftp://nope", {CLOUD_CORE_ENVIRONMENT: environment})
      expect([environment, portalModuleAccess("billing", broken, recordingLog())]).toEqual([environment, {state: "unavailable"}])
      const noSecret = hosted(url, {CLOUD_CORE_ENVIRONMENT: environment, CLOUD_CORE_BILLING_SECRET: ""})
      expect([environment, portalModuleAccess("billing", noSecret, recordingLog())]).toEqual([environment, {state: "unavailable"}])
    }
  })

  test("is ready, with where to forward and how to sign, wherever it is installed and usable: staging and dev as on prod", () => {
    for (const environment of ENVIRONMENTS) {
      const access = portalModuleAccess("billing", hosted(url, {CLOUD_CORE_ENVIRONMENT: environment}))
      expect([environment, access.state]).toEqual([environment, "ready"])
      if (access.state !== "ready") throw new Error("not ready")
      expect(access.baseUrl.href).toBe(`${url}/`)
      expect(access.secret).toBe(SECRET)
    }
  })
})

describe("portalModulePublicAccess", () => {
  const url = "https://store.example.test"
  const get = (rest: string, method = "GET") => ({method, rest})

  test("is ready for GET of one product under public/products, on every Core: no person is asked about", () => {
    for (const environment of ["prod", "staging", "dev", "", undefined]) {
      for (const rest of [
        "products/mentra.call.unlimited",
        "products/a",
        "products/0",
        "products/a_b-c.d",
        "products/..a",
        "products/a..",
        "products/.hidden",
        `products/${"a".repeat(100)}`,
      ]) {
        const access = portalModulePublicAccess("billing", get(rest), hosted(url, {CLOUD_CORE_ENVIRONMENT: environment}), recordingLog())
        expect([environment, rest, access.state]).toEqual([environment, rest, "ready"])
        if (access.state !== "ready") throw new Error("not ready")
        expect(access.baseUrl.href).toBe(`${url}/`)
        expect(access.secret).toBe(SECRET)
      }
    }
  })

  test("is hidden for every other request: methods, case, encodings, dots and segments", () => {
    const closed = [
      // Methods: GET only, in its own case.
      get("products/mentra.call.unlimited", "HEAD"),
      get("products/mentra.call.unlimited", "POST"),
      get("products/mentra.call.unlimited", "PUT"),
      get("products/mentra.call.unlimited", "PATCH"),
      get("products/mentra.call.unlimited", "DELETE"),
      get("products/mentra.call.unlimited", "OPTIONS"),
      get("products/mentra.call.unlimited", "get"),
      // The family: exactly `products`.
      get("Products/mentra.call.unlimited"),
      get("PRODUCTS/mentra.call.unlimited"),
      get("product/mentra.call.unlimited"),
      get("productsx/mentra.call.unlimited"),
      get("%70roducts/mentra.call.unlimited"),
      get("catalog/mentra.call.unlimited"),
      get("icons/a.png"),
      // No product, or more than one segment.
      get(""),
      get("products"),
      get("products/"),
      get("/products/a"),
      get("products//a"),
      get("products/a/"),
      get("products/a/b"),
      get("products/a/name"),
      // The key: 1 to 100 of lowercase letters, digits, `.`, `_` and `-`, and not only dots.
      get(`products/${"a".repeat(101)}`),
      get("products/Mentra.call.unlimited"),
      get("products/MENTRA"),
      get("products/."),
      get("products/.."),
      get("products/..."),
      get("products/%2e%2e"),
      get("products/%2E"),
      get("products/%61"),
      get("products/a%2fb"),
      get("products/a%20b"),
      get("products/a b"),
      get("products/a+b"),
      get("products/a;b"),
      get("products/a?b"),
      get("products/a#b"),
      get("products/a\\b"),
      get("products/a~b"),
      get("products/é"),
      get("products/a\u0000"),
      get("products/a\n"),
    ]
    for (const request of closed) {
      expect([request, portalModulePublicAccess("billing", request, hosted(url), recordingLog())]).toEqual([request, {state: "hidden"}])
    }
  })

  test("does not make an absent module present, and a broken one is unavailable for a public read only", () => {
    expect(portalModulePublicAccess("billing", get("products/a"), env({CLOUD_CORE_ENVIRONMENT: "prod"}), recordingLog())).toEqual({state: "hidden"})
    expect(portalModulePublicAccess("billing", get("products/a"), env({CLOUD_CORE_BILLING_SECRET: SECRET}), recordingLog())).toEqual({state: "hidden"})
    const broken = hosted("ftp://nope", {CLOUD_CORE_ENVIRONMENT: "staging"})
    expect(portalModulePublicAccess("billing", get("products/a"), broken, recordingLog())).toEqual({state: "unavailable"})
    expect(portalModulePublicAccess("billing", get("products/A"), broken, recordingLog())).toEqual({state: "hidden"})
    const noSecret = hosted(url, {CLOUD_CORE_BILLING_SECRET: ""})
    expect(portalModulePublicAccess("billing", get("products/a"), noSecret, recordingLog())).toEqual({state: "unavailable"})
  })
})

describe("installedPortalModules and portalModuleAvailability", () => {
  test("a module is installed when it is ready; an unconfigured or broken one is not offered", () => {
    expect(installedPortalModules(env())).toEqual([])
    expect(installedPortalModules(env({CLOUD_CORE_BILLING_URL: "https://store.example.test"}), recordingLog())).toEqual([])
    expect(installedPortalModules(hosted("https://store.example.test"))).toEqual(["billing"] satisfies PortalModuleName[])
  })

  test("availability is billing installed and usable, the same on every Core", () => {
    for (const environment of ENVIRONMENTS) {
      const ready = hosted("https://store.example.test", {CLOUD_CORE_ENVIRONMENT: environment})
      expect([environment, portalModuleAvailability(ready)]).toEqual([environment, {billing: true}])
      // Not installed, or installed with settings Core cannot use: not offered.
      expect([environment, portalModuleAvailability(env({CLOUD_CORE_ENVIRONMENT: environment}))]).toEqual([environment, {billing: false}])
      const broken = hosted("ftp://nope", {CLOUD_CORE_ENVIRONMENT: environment})
      expect([environment, portalModuleAvailability(broken, recordingLog())]).toEqual([environment, {billing: false}])
    }
  })
})
