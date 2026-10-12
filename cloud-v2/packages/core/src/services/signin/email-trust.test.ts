import {afterEach, expect, test} from "bun:test"

import {isOrganizationAdminEmail} from "../admin-email-policy"
import type {WebIdentityProvider} from "./config"
import {canonicalEmail, trustedEmail} from "./email-trust"

const contoso: WebIdentityProvider = {
  kind: "oidc_provider",
  sourceId: "entra",
  tenantId: "contoso",
  issuer: "https://login.microsoftonline.com/t/v2.0",
  jwksUrl: "https://login.microsoftonline.com/t/discovery/v2.0/keys",
  subjectClaim: "oid",
  directoryTenantClaim: "tid",
  expectedDirectoryTenantId: "t",
  algorithms: ["RS256"],
  verifiedEmailDomains: ["contoso.com"],
  browser: null,
}

const savedAdmins = process.env.CLOUD_CORE_ADMIN_EMAILS
afterEach(() => {
  if (savedAdmins === undefined) delete process.env.CLOUD_CORE_ADMIN_EMAILS
  else process.env.CLOUD_CORE_ADMIN_EMAILS = savedAdmins
})

test("a listed domain is verified", () => {
  expect(trustedEmail({provider: contoso, email: "Bob@CONTOSO.com"})).toEqual({email: "bob@contoso.com", verified: true})
})

test.each(["alex@mentra.glass", "ALEX@MENTRA.GLASS", "bob@sub.contoso.com", "bob@contoso.com.", "bob@contosö.com", "x"])(
  "%s is not verified from a provider",
  email => {
    expect(trustedEmail({provider: contoso, email}).verified).toBe(false)
  },
)

test("email_verified false wins", () => {
  expect(trustedEmail({provider: contoso, email: "bob@contoso.com", tokenEmailVerified: false}).verified).toBe(false)
})

test("Supabase trusts confirmation only", () => {
  const supa: WebIdentityProvider = {...contoso, kind: "supabase", sourceId: "mentra", tenantId: "mentra", verifiedEmailDomains: []}
  expect(trustedEmail({provider: supa, email: "a@b.co", supabaseEmailConfirmed: true}).verified).toBe(true)
  expect(trustedEmail({provider: supa, email: "a@b.co"}).verified).toBe(false)
  expect(trustedEmail({provider: supa, email: "a@b.co", tokenEmailVerified: true}).verified).toBe(false)
})

test("an unverified allowlisted email is not an Organization Admin", () => {
  process.env.CLOUD_CORE_ADMIN_EMAILS = "alex@mentra.glass"
  expect(isOrganizationAdminEmail({email: "alex@mentra.glass", verified: false})).toBe(false)
  expect(isOrganizationAdminEmail({email: "alex@mentra.glass", verified: true})).toBe(true)
  expect(isOrganizationAdminEmail({email: null, verified: true})).toBe(false)
})

test("a provider asserting an allowlisted Mentra address does not make an Organization Admin", () => {
  process.env.CLOUD_CORE_ADMIN_EMAILS = "alex@mentra.glass"
  for (const email of ["alex@mentra.glass", "ALEX@MENTRA.GLASS", "alex@mentra.glass."]) {
    expect(isOrganizationAdminEmail(trustedEmail({provider: contoso, email}))).toBe(false)
  }
})

test("canonicalEmail trims, lowercases, and refuses malformed or non-ASCII addresses", () => {
  expect(canonicalEmail("  A@B.Co ")).toBe("a@b.co")
  for (const bad of [undefined, null, 1, "", "a", "a@", "@b.co", "a@b@c.co", "a b@c.co", "a@b.co.", "a@b..co", "a@b", "ä@b.co", "a@-b.co"]) {
    expect(canonicalEmail(bad)).toBeNull()
  }
})
