import {BILLING_ICON_PATH_PREFIX, billingIconPath} from "@mentra/workspace-contract/portal-billing"
import {describe, expect, test} from "bun:test"
import {
  installedPortalModules,
  portalModuleAccess,
  portalModuleAvailability,
  portalModuleConfig,
  portalModuleVisibleTo,
  type ConfigLog,
  type PortalModuleName,
  type PortalModuleRequest,
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

/** A request as `portal-modules.api.ts` describes one to the access rules: its method, its family and what follows the scope. */
const read = (
  kind: PortalModuleRequest["route"]["kind"],
  rest: string,
  method = "GET",
): PortalModuleRequest => ({method, route: {kind}, rest})

describe("portalModuleAccess for an open read", () => {
  const url = "https://store.example.test"
  const staging = (extra: Record<string, string | undefined> = {}) => hosted(url, {CLOUD_CORE_ENVIRONMENT: "staging", ...extra})

  test("is ready for someone the module is hidden from, for GET of a catalog and GET or HEAD of an icon", () => {
    for (const request of [
      read("workspace", "catalog"),
      read("ui", "icons/mentra.call.unlimited.png"),
      read("ui", "icons/x.svg"),
      read("ui", "icons/x.png", "HEAD"),
    ]) {
      const access = portalModuleAccess("billing", everyoneElse, staging(), recordingLog(), request)
      expect([request, access.state]).toEqual([request, "ready"])
      if (access.state !== "ready") throw new Error("not ready")
      expect(access.baseUrl.href).toBe(`${url}/`)
      expect(access.secret).toBe(SECRET)
    }
  })

  test("is still hidden for every other request, exact paths only", () => {
    const closed: PortalModuleRequest[] = [
      // Other paths and methods under a scope.
      read("workspace", "status"),
      read("workspace", "summary"),
      read("workspace", "purchase", "POST"),
      read("workspace", "session", "POST"),
      read("workspace", "", "GET"),
      read("workspace", "catalog", "POST"),
      read("workspace", "catalog", "HEAD"),
      read("workspace", "catalog", "PUT"),
      read("workspace", "catalog", "DELETE"),
      read("workspace", "catalog", "PATCH"),
      read("workspace", "catalog", "OPTIONS"),
      read("workspace", "catalog", "get"),
      // The path is matched as received: no trailing slash, case, encoding or deeper path.
      read("workspace", "catalog/"),
      read("workspace", "/catalog"),
      read("workspace", "Catalog"),
      read("workspace", "CATALOG"),
      read("workspace", "catalog/x"),
      read("workspace", "x/catalog"),
      read("workspace", "%63atalog"),
      read("workspace", "catalog%2f"),
      read("workspace", "catalog "),
      read("workspace", "catalog;x"),
      read("workspace", "catalog?x"),
      // Assets: icons only, GET and HEAD only, one file.
      read("ui", "entry.js"),
      read("ui", "entry.js", "HEAD"),
      read("ui", "icons"),
      read("ui", "icons/"),
      read("ui", "iconsx/a.png"),
      read("ui", "Icons/a.png"),
      read("ui", "ICONS/a.png"),
      read("ui", "icons/a/b.png"),
      read("ui", "icons//a.png"),
      read("ui", "icons/a.png/"),
      read("ui", "icons/.."),
      read("ui", "icons/."),
      read("ui", "icons/%78.png"),
      read("ui", "icons/a b.png"),
      read("ui", "icons/a.png", "POST"),
      read("ui", "icons/a.png", "PUT"),
      read("ui", "icons/a.png", "DELETE"),
      read("ui", "icons/a.png", "PATCH"),
      read("ui", "icons/a.png", "OPTIONS"),
      read("ui", "icons/a.png", "head"),
      // The open paths belong to their own family only.
      read("ui", "catalog"),
      read("workspace", "icons/a.png"),
      read("workspace", "ui/icons/a.png"),
    ]
    for (const request of closed) {
      expect([request, portalModuleAccess("billing", everyoneElse, staging(), recordingLog(), request)]).toEqual([
        request,
        {state: "hidden"},
      ])
    }
  })

  test("an icon is open exactly when the contract accepts its path: one rule for both", () => {
    for (const file of [
      "mentra.call.unlimited.png",
      "x.svg",
      "a_b-c.PNG",
      "..a",
      "a..",
      ".hidden",
      "1",
      "a".repeat(255),
      "a".repeat(256),
      ".",
      "..",
      "...",
      "",
      "a b.png",
      "a%20b.png",
      "a/b.png",
      "a\\b.png",
      "a?b.png",
      "a#b.png",
      'a".png',
      "a(1).png",
      "é.png",
    ]) {
      const access = portalModuleAccess("billing", everyoneElse, staging(), recordingLog(), read("ui", `icons/${file}`))
      expect([file, access.state === "ready"]).toEqual([file, billingIconPath(`${BILLING_ICON_PATH_PREFIX}${file}`) !== null])
    }
  })

  test("is hidden without a request, as before", () => {
    expect(portalModuleAccess("billing", everyoneElse, staging(), recordingLog())).toEqual({state: "hidden"})
    expect(portalModuleAccess("billing", everyoneElse, staging(), recordingLog(), undefined)).toEqual({state: "hidden"})
  })

  test("does not make an absent module present: not installed stays hidden", () => {
    expect(portalModuleAccess("billing", everyoneElse, env({CLOUD_CORE_ENVIRONMENT: "staging"}), recordingLog(), read("workspace", "catalog"))).toEqual({
      state: "hidden",
    })
    const secretOnly = env({CLOUD_CORE_ENVIRONMENT: "staging", CLOUD_CORE_BILLING_SECRET: SECRET})
    expect(portalModuleAccess("billing", everyoneElse, secretOnly, recordingLog(), read("ui", "icons/a.png"))).toEqual({
      state: "hidden",
    })
  })

  test("a module whose settings are unusable is unavailable for an open read and hidden for anything else", () => {
    const broken = staging({CLOUD_CORE_BILLING_URL: "ftp://nope"})
    expect(portalModuleAccess("billing", everyoneElse, broken, recordingLog(), read("workspace", "catalog"))).toEqual({state: "unavailable"})
    expect(portalModuleAccess("billing", everyoneElse, broken, recordingLog(), read("ui", "icons/a.png"))).toEqual({state: "unavailable"})
    expect(portalModuleAccess("billing", everyoneElse, broken, recordingLog(), read("workspace", "status"))).toEqual({state: "hidden"})
    const noSecret = staging({CLOUD_CORE_BILLING_SECRET: ""})
    expect(portalModuleAccess("billing", everyoneElse, noSecret, recordingLog(), read("workspace", "catalog"))).toEqual({state: "unavailable"})
    expect(portalModuleAccess("billing", everyoneElse, noSecret, recordingLog(), read("ui", "entry.js"))).toEqual({state: "hidden"})
  })

  test("a request changes nothing for staff or on prod: every request is ready", () => {
    for (const request of [read("workspace", "status"), read("ui", "entry.js"), read("workspace", "purchase", "POST"), read("workspace", "catalog/x")]) {
      expect([request, portalModuleAccess("billing", staff, staging(), recordingLog(), request).state]).toEqual([request, "ready"])
      expect([request, portalModuleAccess("billing", everyoneElse, hosted(url), recordingLog(), request).state]).toEqual([request, "ready"])
    }
  })
})

describe("installedPortalModules and portalModuleAvailability", () => {
  test("a module is installed when it is ready; an unconfigured or broken one is not offered", () => {
    expect(installedPortalModules(env())).toEqual([])
    expect(installedPortalModules(env({CLOUD_CORE_BILLING_URL: "https://store.example.test"}), recordingLog())).toEqual([])
    expect(installedPortalModules(hosted("https://store.example.test"))).toEqual(["billing"] satisfies PortalModuleName[])
  })

  test("availability is installed and visible to this person, and says separately whether the catalog can be read", () => {
    const ready = (environment: string) => hosted("https://store.example.test", {CLOUD_CORE_ENVIRONMENT: environment})
    expect(portalModuleAvailability(everyoneElse, ready("prod"))).toEqual({billing: true, billingCatalog: true})
    // Outside prod the module is for staff, but its catalog is for everyone.
    expect(portalModuleAvailability(everyoneElse, ready("staging"))).toEqual({billing: false, billingCatalog: true})
    expect(portalModuleAvailability(everyoneElse, ready("dev"))).toEqual({billing: false, billingCatalog: true})
    expect(portalModuleAvailability(everyoneElse, ready(""))).toEqual({billing: false, billingCatalog: true})
    expect(portalModuleAvailability(staff, ready("staging"))).toEqual({billing: true, billingCatalog: true})
    // Not installed: neither.
    expect(portalModuleAvailability(staff, env({CLOUD_CORE_ENVIRONMENT: "prod"}))).toEqual({billing: false, billingCatalog: false})
    expect(portalModuleAvailability(everyoneElse, env({CLOUD_CORE_ENVIRONMENT: "staging"}))).toEqual({billing: false, billingCatalog: false})
    // Misconfigured: neither, whoever asks.
    expect(portalModuleAvailability(staff, hosted("ftp://nope"), recordingLog())).toEqual({billing: false, billingCatalog: false})
    expect(portalModuleAvailability(everyoneElse, hosted("ftp://nope"), recordingLog())).toEqual({billing: false, billingCatalog: false})
    expect(portalModuleAvailability(everyoneElse, hosted("ftp://nope", {CLOUD_CORE_ENVIRONMENT: "staging"}), recordingLog())).toEqual({
      billing: false,
      billingCatalog: false,
    })
  })
})
