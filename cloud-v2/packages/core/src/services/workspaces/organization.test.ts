import {afterEach, expect, test} from "bun:test"
import {
  configuredAdminAllowlist,
  credentialEnvironmentLabels,
  isConfiguredOrganizationAdminEmail,
  isOrganizationAdminEmail,
  organizationId,
} from "./organization"

const ENV_NAMES = [
  "CLOUD_CORE_ADMIN_EMAILS",
  "CLOUD_CORE_ADMIN_EMAIL_DOMAINS",
  "CLOUD_CORE_ORGANIZATION_ID",
  "CLOUD_CORE_CREDENTIAL_ENVIRONMENTS",
  "CLOUD_CORE_ENVIRONMENT",
  "NODE_ENV",
] as const
const saved = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]))

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

function clearEnv() {
  for (const name of ENV_NAMES) delete process.env[name]
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return (err as Error).message
  }
  throw new Error("expected the call to throw")
}

// --- organizationId ---------------------------------------------------------

test("organizationId defaults to local outside production", () => {
  clearEnv()
  expect(organizationId()).toBe("local")
  process.env.NODE_ENV = "development"
  expect(organizationId()).toBe("local")
  process.env.CLOUD_CORE_ORGANIZATION_ID = "   "
  expect(organizationId()).toBe("local")
})

test("organizationId is required for a deployed environment even though deployed Cores never set NODE_ENV=production", () => {
  for (const environment of ["dev", "staging", "prod", "production", " Prod ", "STAGING"]) {
    clearEnv()
    process.env.CLOUD_CORE_ENVIRONMENT = environment
    expect([environment, thrownMessage(organizationId)]).toEqual([
      environment,
      expect.stringContaining("CLOUD_CORE_ORGANIZATION_ID"),
    ])
    process.env.CLOUD_CORE_ORGANIZATION_ID = "   "
    expect(thrownMessage(organizationId)).toContain("CLOUD_CORE_ORGANIZATION_ID")
    process.env.CLOUD_CORE_ORGANIZATION_ID = "acme-prod"
    expect(organizationId()).toBe("acme-prod")
  }
})

test("organizationId's error names both ways a deployment is recognized", () => {
  clearEnv()
  process.env.CLOUD_CORE_ENVIRONMENT = "staging"
  const message = thrownMessage(organizationId)
  expect(message).toContain("NODE_ENV=production")
  expect(message).toContain("CLOUD_CORE_ENVIRONMENT")
})

test("organizationId still defaults to local for local, test and unlabeled environments", () => {
  for (const environment of [undefined, "", "   ", "local", "test", "test-env", "development", "dev-2", "my-prod"]) {
    clearEnv()
    if (environment !== undefined) process.env.CLOUD_CORE_ENVIRONMENT = environment
    expect([environment, organizationId()]).toEqual([environment, "local"])
  }
})

test("organizationId reads CLOUD_CORE_ORGANIZATION_ID at use time", () => {
  clearEnv()
  process.env.CLOUD_CORE_ORGANIZATION_ID = "acme-prod"
  expect(organizationId()).toBe("acme-prod")
  process.env.CLOUD_CORE_ORGANIZATION_ID = " acme-2 "
  expect(organizationId()).toBe("acme-2")
  process.env.CLOUD_CORE_ORGANIZATION_ID = "a1"
  expect(organizationId()).toBe("a1")
  process.env.CLOUD_CORE_ORGANIZATION_ID = "a".repeat(63)
  expect(organizationId()).toBe("a".repeat(63))
})

test("organizationId rejects values outside /^[a-z0-9][a-z0-9-]{1,62}$/", () => {
  clearEnv()
  for (const bad of ["a", "-acme", "Acme", "acme_prod", "acme.prod", "acme prod", "a".repeat(64), "acmé"]) {
    process.env.CLOUD_CORE_ORGANIZATION_ID = bad
    expect(thrownMessage(organizationId)).toContain("CLOUD_CORE_ORGANIZATION_ID")
  }
})

test("organizationId is required in production and throws at first use, not at import", () => {
  clearEnv()
  process.env.NODE_ENV = "production"
  expect(thrownMessage(organizationId)).toContain("CLOUD_CORE_ORGANIZATION_ID")
  process.env.CLOUD_CORE_ORGANIZATION_ID = ""
  expect(thrownMessage(organizationId)).toContain("CLOUD_CORE_ORGANIZATION_ID")
  process.env.CLOUD_CORE_ORGANIZATION_ID = "acme-prod"
  expect(organizationId()).toBe("acme-prod")
})

// --- Organization Admin matching (ported from the former admin-email-policy tests) -----------

test("admin matching normalizes allowlists and only admits exact emails or domains", () => {
  process.env.CLOUD_CORE_ADMIN_EMAILS = " Named@personal.test , api-key@service.local "
  process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = " company.test, @SECOND.test "
  for (const email of [" NAMED@PERSONAL.TEST ", "api-key@service.local", "user@company.test", "user@second.test"]) {
    expect(isOrganizationAdminEmail(email, true)).toBe(true)
    expect(isConfiguredOrganizationAdminEmail(email)).toBe(true)
  }
  for (const email of [
    "other@personal.test",
    "user@sub.company.test",
    "user@company.test.evil.test",
    "user@notcompany.test",
  ]) {
    expect(isOrganizationAdminEmail(email, true)).toBe(false)
    expect(isConfiguredOrganizationAdminEmail(email)).toBe(false)
  }
})

test("missing allowlists fail closed and changes are read at use time", () => {
  delete process.env.CLOUD_CORE_ADMIN_EMAILS
  delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS
  expect(isOrganizationAdminEmail("user@mentraglass.com", true)).toBe(false)
  expect(isConfiguredOrganizationAdminEmail("user@mentraglass.com")).toBe(false)
  process.env.CLOUD_CORE_ADMIN_EMAILS = "user@personal.test"
  expect(isOrganizationAdminEmail("user@personal.test", true)).toBe(true)
  process.env.CLOUD_CORE_ADMIN_EMAILS = ""
  expect(isOrganizationAdminEmail("user@personal.test", true)).toBe(false)
})

test("an unverified identity email is never an Organization Admin, even when allowlisted", () => {
  process.env.CLOUD_CORE_ADMIN_EMAILS = "a@mentra.glass"
  process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = "company.test"
  expect(isOrganizationAdminEmail("a@mentra.glass", false)).toBe(false)
  expect(isOrganizationAdminEmail("user@company.test", false)).toBe(false)
  expect(isOrganizationAdminEmail("a@mentra.glass", true)).toBe(true)
  expect(isOrganizationAdminEmail("user@company.test", true)).toBe(true)
  // The config-list match alone does not look at verification: report
  // categorization uses it for already-resolved account emails.
  expect(isConfiguredOrganizationAdminEmail("a@mentra.glass")).toBe(true)
})

test("a missing or blank email is never an Organization Admin", () => {
  process.env.CLOUD_CORE_ADMIN_EMAILS = "a@mentra.glass"
  process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = "company.test"
  expect(isOrganizationAdminEmail(null, true)).toBe(false)
  expect(isOrganizationAdminEmail("", true)).toBe(false)
  expect(isOrganizationAdminEmail("   ", true)).toBe(false)
  expect(isConfiguredOrganizationAdminEmail(null)).toBe(false)
  expect(isConfiguredOrganizationAdminEmail("")).toBe(false)
})

test("configuredAdminAllowlist lowercases entries and strips a leading @ from domains", () => {
  process.env.CLOUD_CORE_ADMIN_EMAILS = " A@B.test, ,c@d.test "
  process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = "@One.test,two.test"
  expect(configuredAdminAllowlist()).toEqual({
    emails: ["a@b.test", "c@d.test"],
    domains: ["one.test", "two.test"],
  })
})

// --- credentialEnvironmentLabels ----------------------------------------------

test("credential environment labels default to local", () => {
  clearEnv()
  expect(credentialEnvironmentLabels()).toEqual(["local"])
})

test("credential environment labels fall back to the single Core environment, normalized", () => {
  clearEnv()
  process.env.CLOUD_CORE_ENVIRONMENT = "Prod-1_EU"
  expect(credentialEnvironmentLabels()).toEqual(["prod1eu"])
  process.env.CLOUD_CORE_ENVIRONMENT = "staging"
  expect(credentialEnvironmentLabels()).toEqual(["staging"])
})

test("credential environment list overrides the Core environment and is normalized", () => {
  clearEnv()
  process.env.CLOUD_CORE_ENVIRONMENT = "dev"
  process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS = " Prod, stag_ing ,dev-2,prod"
  expect(credentialEnvironmentLabels()).toEqual(["prod", "staging", "dev2"])
})

test("blank or fully stripped values count as unset", () => {
  clearEnv()
  process.env.CLOUD_CORE_ENVIRONMENT = "dev"
  process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS = " , "
  expect(credentialEnvironmentLabels()).toEqual(["dev"])
  process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS = "---,___"
  expect(credentialEnvironmentLabels()).toEqual(["dev"])
  process.env.CLOUD_CORE_ENVIRONMENT = "!!!"
  expect(credentialEnvironmentLabels()).toEqual(["local"])
})
