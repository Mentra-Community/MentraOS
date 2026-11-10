import {afterEach, describe, expect, test} from "bun:test"

import {assertCoreIssuerConfiguration} from "./core-issuer"

const saved = {issuer: process.env.CLOUD_CORE_ISSUER, environment: process.env.CLOUD_CORE_ENVIRONMENT}

afterEach(() => {
  for (const [key, value] of [["CLOUD_CORE_ISSUER", saved.issuer], ["CLOUD_CORE_ENVIRONMENT", saved.environment]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("CLOUD_CORE_ISSUER", () => {
  test("may be unset, cloud-core, or this Core's HTTPS origin", () => {
    for (const value of [undefined, "cloud-core", "https://core.mentraglass.com"]) {
      if (value === undefined) delete process.env.CLOUD_CORE_ISSUER
      else process.env.CLOUD_CORE_ISSUER = value
      assertCoreIssuerConfiguration()
    }
  })

  test("refuses anything a bound backend would not match", () => {
    for (const value of [
      "mentra",
      "core.mentraglass.com",
      "https://core.mentraglass.com/",
      "https://Core.MentraGlass.com",
      "https://core.mentraglass.com/api",
      "http://core.mentraglass.com",
    ]) {
      process.env.CLOUD_CORE_ISSUER = value
      expect(() => assertCoreIssuerConfiguration()).toThrow("CLOUD_CORE_ISSUER")
    }
  })

  test("allows a loopback HTTP origin on an undeployed Core", () => {
    delete process.env.CLOUD_CORE_ENVIRONMENT
    process.env.CLOUD_CORE_ISSUER = "http://localhost:3000"
    assertCoreIssuerConfiguration()
    process.env.CLOUD_CORE_ENVIRONMENT = "prod"
    expect(() => assertCoreIssuerConfiguration()).toThrow("HTTPS")
  })
})
