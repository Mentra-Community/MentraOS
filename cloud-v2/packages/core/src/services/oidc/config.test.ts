import {afterEach, describe, expect, test} from "bun:test"

import {ConfigurationError} from "../signin/config"
import {assertOidcIssuerConfiguration, endSessionUrl, oidcCookieKeys, oidcIssuer} from "./config"

const NAMES = [
  "CLOUD_CORE_OIDC_ISSUER",
  "CLOUD_CORE_OIDC_COOKIE_KEYS",
  "CLOUD_CORE_ISSUER",
  "CLOUD_CORE_ENVIRONMENT",
  "MENTRA_JWT_PRIVATE_KEY",
  "MENTRA_JWT_PUBLIC_KEY",
  "NODE_ENV",
] as const
const saved = Object.fromEntries(NAMES.map(name => [name, process.env[name]]))

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

function set(env: Partial<Record<(typeof NAMES)[number], string | undefined>>) {
  const base = {
    CLOUD_CORE_OIDC_ISSUER: "https://account.dev.mentraglass.com",
    CLOUD_CORE_OIDC_COOKIE_KEYS: "a".repeat(32),
    CLOUD_CORE_ISSUER: "cloud-core",
    CLOUD_CORE_ENVIRONMENT: "dev",
    MENTRA_JWT_PRIVATE_KEY: "private",
    MENTRA_JWT_PUBLIC_KEY: "public",
    NODE_ENV: undefined,
  }
  for (const [name, value] of Object.entries({...base, ...env})) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

describe("Core's sign-in server configuration", () => {
  test("off without an issuer: nothing to check", () => {
    set({CLOUD_CORE_OIDC_ISSUER: undefined, CLOUD_CORE_OIDC_COOKIE_KEYS: undefined})
    expect(oidcIssuer()).toBeNull()
    expect(endSessionUrl()).toBeNull()
    expect(() => assertOidcIssuerConfiguration()).not.toThrow()
  })

  test("a valid hosted configuration", () => {
    set({CLOUD_CORE_OIDC_ISSUER: "https://account.dev.mentraglass.com/", CLOUD_CORE_OIDC_COOKIE_KEYS: `${"a".repeat(32)}, ${"b".repeat(40)}`})
    expect(oidcIssuer()).toBe("https://account.dev.mentraglass.com")
    expect(oidcCookieKeys()).toEqual(["a".repeat(32), "b".repeat(40)])
    expect(endSessionUrl()).toBe("https://account.dev.mentraglass.com/oidc/session/end")
    expect(() => assertOidcIssuerConfiguration()).not.toThrow()
  })

  test.each([
    ["an issuer with a path", {CLOUD_CORE_OIDC_ISSUER: "https://account.test/oidc"}, "no path"],
    ["an HTTP issuer on a deployed Core", {CLOUD_CORE_OIDC_ISSUER: "http://127.0.0.1:4000"}, "HTTPS"],
    ["no cookie keys", {CLOUD_CORE_OIDC_COOKIE_KEYS: undefined}, "CLOUD_CORE_OIDC_COOKIE_KEYS must be set"],
    ["a short cookie key", {CLOUD_CORE_OIDC_COOKIE_KEYS: `${"a".repeat(32)},short`}, "at least 32 characters"],
    ["no signing key", {MENTRA_JWT_PRIVATE_KEY: undefined}, "MENTRA_JWT_PRIVATE_KEY"],
  ] as const)("refuses %s", (_label, env, message) => {
    set(env)
    expect(() => assertOidcIssuerConfiguration()).toThrow(ConfigurationError)
    expect(() => assertOidcIssuerConfiguration()).toThrow(message)
  })

  test("a Private Cloud's issuer may equal CLOUD_CORE_ISSUER, its own host: token types are kept apart by key ID, type and audience", () => {
    set({CLOUD_CORE_OIDC_ISSUER: "https://mentra.contoso.com", CLOUD_CORE_ISSUER: "https://mentra.contoso.com"})
    expect(() => assertOidcIssuerConfiguration()).not.toThrow()
  })

  test("a loopback HTTP issuer is allowed only on an undeployed Core", () => {
    set({CLOUD_CORE_OIDC_ISSUER: "http://127.0.0.1:4000", CLOUD_CORE_ENVIRONMENT: undefined})
    expect(() => assertOidcIssuerConfiguration()).not.toThrow()
  })

  test("an IPv6 loopback HTTP issuer counts as loopback", () => {
    // URL.hostname keeps the brackets of an IPv6 literal: "[::1]".
    set({CLOUD_CORE_OIDC_ISSUER: "http://[::1]:4000", CLOUD_CORE_ENVIRONMENT: undefined})
    expect(() => assertOidcIssuerConfiguration()).not.toThrow()
  })
})
