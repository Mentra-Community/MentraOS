import {afterEach, expect, test} from "bun:test"
import {
  configuredAdminAllowlist,
  credentialEnvironmentLabels,
  isConfiguredOrganizationAdminEmail,
  isDeployedEnvironment,
  isOrganizationAdminEmail,
} from "./organization"

const ENV_NAMES = [
  "CLOUD_CORE_ADMIN_EMAILS",
  "CLOUD_CORE_ADMIN_EMAIL_DOMAINS",
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

// --- isDeployedEnvironment --------------------------------------------------

test("a deployed environment is recognized by its label even though deployed Cores never set NODE_ENV=production", () => {
  for (const environment of ["dev", "staging", "prod", "production", " Prod ", "STAGING"]) {
    clearEnv()
    process.env.CLOUD_CORE_ENVIRONMENT = environment
    expect([environment, isDeployedEnvironment()]).toEqual([environment, true])
  }
})

test("NODE_ENV=production alone makes a deployed environment", () => {
  clearEnv()
  process.env.NODE_ENV = "production"
  expect(isDeployedEnvironment()).toBe(true)
  process.env.NODE_ENV = "development"
  expect(isDeployedEnvironment()).toBe(false)
})

test("local, test and unlabeled environments are not deployed", () => {
  for (const environment of [undefined, "", "   ", "local", "test", "test-env", "development", "dev-2", "my-prod"]) {
    clearEnv()
    if (environment !== undefined) process.env.CLOUD_CORE_ENVIRONMENT = environment
    expect([environment, isDeployedEnvironment()]).toEqual([environment, false])
  }
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

test("plus tags inherit an allowlisted base email for any domain", () => {
  process.env.CLOUD_CORE_ADMIN_EMAILS = "example-admin@gmail.com, named@personal.test"
  delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS
  for (const email of [
    "example-admin@gmail.com",
    "example-admin+test@gmail.com",
    " EXAMPLE-ADMIN+one+two@GMAIL.COM ",
    "named+test@personal.test",
  ]) {
    expect(isOrganizationAdminEmail(email, true)).toBe(true)
  }
  for (const email of [
    "example-admin2+test@gmail.com",
    "other+example-admin@gmail.com",
    "example-admin+test@evil.test",
    "example-admin+test@gmail.com.evil.test",
    "example-admin+@gmail.com",
    "example-admin+test@evil@gmail.com",
    "example-admin+test @gmail.com",
    "+test@gmail.com",
  ]) {
    expect(isOrganizationAdminEmail(email, true)).toBe(false)
  }
  // A tagged alias is still only an Organization Admin once verified.
  expect(isOrganizationAdminEmail("example-admin+test@gmail.com", false)).toBe(false)
  process.env.CLOUD_CORE_ADMIN_EMAILS = ""
  expect(isOrganizationAdminEmail("example-admin+test@gmail.com", true)).toBe(false)
})

test("an explicitly allowlisted tagged address does not allow its base or sibling aliases", () => {
  process.env.CLOUD_CORE_ADMIN_EMAILS = "named+specific@personal.test"
  delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS
  expect(isOrganizationAdminEmail("named+specific@personal.test", true)).toBe(true)
  expect(isOrganizationAdminEmail("named@personal.test", true)).toBe(false)
  expect(isOrganizationAdminEmail("named+other@personal.test", true)).toBe(false)
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
