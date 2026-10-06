import {afterEach, expect, test} from "bun:test"
import {warnIfWorkosIdentitiesStaySeparate} from "./identity-link.service"

const ENV_NAMES = [
  "CLOUD_CORE_ENVIRONMENT",
  "NODE_ENV",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
] as const
const saved = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]))

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

/** A deployed Core with WorkOS but no GoTrue admin: the one state that warns. */
function deployedWithWorkosOnly(environment = "dev") {
  for (const name of ENV_NAMES) delete process.env[name]
  process.env.CLOUD_CORE_ENVIRONMENT = environment
  process.env.WORKOS_API_KEY = "sk_test"
  process.env.WORKOS_CLIENT_ID = "client_test"
  process.env.WORKOS_COOKIE_PASSWORD = "test-cookie-password-with-at-least-32-characters"
}

function logSpy() {
  const warnings: Array<{fields: unknown; message: string}> = []
  return {
    warnings,
    log: {warn: ((fields: unknown, message: string) => void warnings.push({fields, message})) as never},
  }
}

test("a deployed Core with WorkOS and no GoTrue admin warns once that sign-ins link to separate identities", () => {
  for (const environment of ["dev", "staging", "prod", "production"]) {
    deployedWithWorkosOnly(environment)
    const {warnings, log} = logSpy()

    expect([environment, warnIfWorkosIdentitiesStaySeparate(log)]).toEqual([environment, true])

    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain("workos-tenant")
    expect(warnings[0]!.message).toContain("SUPABASE_SERVICE_ROLE_KEY")
    expect(warnings[0]!.fields).toEqual({environment})
  }
})

test("NODE_ENV=production counts as deployed too", () => {
  deployedWithWorkosOnly()
  delete process.env.CLOUD_CORE_ENVIRONMENT
  process.env.NODE_ENV = "production"
  const {warnings, log} = logSpy()

  expect(warnIfWorkosIdentitiesStaySeparate(log)).toBe(true)
  expect(warnings).toHaveLength(1)
})

test("it stays quiet when GoTrue admin is configured, even half of it counts as not configured", () => {
  deployedWithWorkosOnly()
  process.env.SUPABASE_URL = "https://supabase.example.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key"
  const configured = logSpy()
  expect(warnIfWorkosIdentitiesStaySeparate(configured.log)).toBe(false)
  expect(configured.warnings).toEqual([])

  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  const half = logSpy()
  expect(warnIfWorkosIdentitiesStaySeparate(half.log)).toBe(true)
  expect(half.warnings).toHaveLength(1)
})

test("it stays quiet when WorkOS is not configured, whatever is missing", () => {
  for (const missing of ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD"] as const) {
    deployedWithWorkosOnly()
    delete process.env[missing]
    const {warnings, log} = logSpy()

    expect([missing, warnIfWorkosIdentitiesStaySeparate(log)]).toEqual([missing, false])
    expect(warnings).toEqual([])
  }
})

test("it stays quiet outside a deployed environment", () => {
  for (const environment of [undefined, "", "local", "test", "development"]) {
    deployedWithWorkosOnly()
    if (environment === undefined) delete process.env.CLOUD_CORE_ENVIRONMENT
    else process.env.CLOUD_CORE_ENVIRONMENT = environment
    const {warnings, log} = logSpy()

    expect([environment, warnIfWorkosIdentitiesStaySeparate(log)]).toEqual([environment, false])
    expect(warnings).toEqual([])
  }
})
