import {describe, expect, test} from "bun:test"
import {
  installedPortalModules,
  portalModuleAccess,
  portalModuleAvailability,
  portalModuleConfig,
  portalModuleVisibleTo,
  type ConfigLog,
  type PortalModuleName,
} from "./portal-modules"

const SECRET = "billing-shared-secret-value"
const staff = {isOrganizationAdmin: true}
const everyoneElse = {isOrganizationAdmin: false}

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

describe("portalModuleVisibleTo", () => {
  test("billing is visible to everyone only on a Core whose environment is exactly prod", () => {
    expect(portalModuleVisibleTo("billing", everyoneElse, env({CLOUD_CORE_ENVIRONMENT: "prod"}))).toBe(true)
    expect(portalModuleVisibleTo("billing", staff, env({CLOUD_CORE_ENVIRONMENT: "prod"}))).toBe(true)
  })

  test("elsewhere billing is staff-only: dev and staging, and any other or unset environment fail closed", () => {
    for (const environment of ["dev", "staging", "production", "Prod", "prod ", "local", "", undefined]) {
      const values = env({CLOUD_CORE_ENVIRONMENT: environment})
      expect([environment, portalModuleVisibleTo("billing", everyoneElse, values)]).toEqual([environment, false])
      expect([environment, portalModuleVisibleTo("billing", staff, values)]).toEqual([environment, true])
    }
  })
})

describe("portalModuleAccess", () => {
  const url = "https://store.example.test"

  test("is hidden when the module is not installed, or is not visible to the person, broken or not", () => {
    expect(portalModuleAccess("billing", staff, env({CLOUD_CORE_ENVIRONMENT: "prod"}))).toEqual({state: "hidden"})
    expect(portalModuleAccess("billing", everyoneElse, hosted(url, {CLOUD_CORE_ENVIRONMENT: "staging"}))).toEqual({state: "hidden"})
    // A broken install is as hidden as an absent one from a person who may not see it.
    const broken = hosted("ftp://nope", {CLOUD_CORE_ENVIRONMENT: "staging"})
    expect(portalModuleAccess("billing", everyoneElse, broken, recordingLog())).toEqual({state: "hidden"})
  })

  test("is unavailable when the person may see a module whose settings are unusable", () => {
    const broken = hosted("ftp://nope", {CLOUD_CORE_ENVIRONMENT: "staging"})
    expect(portalModuleAccess("billing", staff, broken, recordingLog())).toEqual({state: "unavailable"})
    expect(portalModuleAccess("billing", everyoneElse, hosted("ftp://nope"), recordingLog())).toEqual({state: "unavailable"})
  })

  test("is ready, with where to forward and how to sign, when it is installed, usable and visible", () => {
    const access = portalModuleAccess("billing", everyoneElse, hosted(url))
    expect(access.state).toBe("ready")
    if (access.state !== "ready") throw new Error("not ready")
    expect(access.baseUrl.href).toBe(`${url}/`)
    expect(access.secret).toBe(SECRET)
    expect(portalModuleAccess("billing", staff, hosted(url, {CLOUD_CORE_ENVIRONMENT: "dev"})).state).toBe("ready")
  })
})

describe("installedPortalModules and portalModuleAvailability", () => {
  test("a module is installed when it is ready; an unconfigured or broken one is not offered", () => {
    expect(installedPortalModules(env())).toEqual([])
    expect(installedPortalModules(env({CLOUD_CORE_BILLING_URL: "https://store.example.test"}), recordingLog())).toEqual([])
    expect(installedPortalModules(hosted("https://store.example.test"))).toEqual(["billing"] satisfies PortalModuleName[])
  })

  test("availability is installed and visible to this person", () => {
    const ready = (environment: string) => hosted("https://store.example.test", {CLOUD_CORE_ENVIRONMENT: environment})
    expect(portalModuleAvailability(everyoneElse, ready("prod"))).toEqual({billing: true})
    expect(portalModuleAvailability(everyoneElse, ready("staging"))).toEqual({billing: false})
    expect(portalModuleAvailability(staff, ready("staging"))).toEqual({billing: true})
    expect(portalModuleAvailability(staff, env({CLOUD_CORE_ENVIRONMENT: "prod"}))).toEqual({billing: false})
    expect(portalModuleAvailability(staff, hosted("ftp://nope"), recordingLog())).toEqual({billing: false})
  })
})
