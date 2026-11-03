/// <reference types="bun-types" />

import {afterAll, beforeAll, describe, expect, test} from "bun:test"
import {dirname} from "node:path"

import {
  isLocalNetworkHost,
  isPackageNameAllowedForUrl,
  normalizeMiniappUrl,
  packagePrefixForHost,
  registrableDomain,
} from "@mentra/cloud-protocol/miniapp-url"

import {miniappUrlVectors} from "./miniappUrlVectors"

// Core parses URLs with Bun's URL. The Mentra App uses the one Expo installs on Hermes, which keeps a Unicode host
// as it is where Bun's converts it to xn-- form. The shared rules must answer every vector the same with both.
const expoDirectory = dirname(Bun.resolveSync("expo/package.json", import.meta.dir))
const {URL: AppURL} = require(Bun.resolveSync("whatwg-url-minimum", expoDirectory)) as {URL: typeof URL}
const runtimeURL = globalThis.URL
const vectors = miniappUrlVectors()

beforeAll(() => {
  globalThis.URL = AppURL
})

afterAll(() => {
  globalThis.URL = runtimeURL
})

describe("the miniapp URL rules, with the Mentra App's URL implementation", () => {
  test("is the implementation under test", () => {
    expect(globalThis.URL).toBe(AppURL)
    expect(new URL("https://münchen.de/").hostname).not.toBe(new runtimeURL("https://münchen.de/").hostname)
  })

  test.each(vectors.normalize.map((vector) => [vector.input, vector.expected] as const))(
    "normalizes %p",
    (input, expected) => {
      expect(normalizeMiniappUrl(input)).toEqual(expected as never)
    },
  )

  test.each(vectors.registrableDomain.map((vector) => [vector.host, vector.expected] as const))(
    "finds the registrable domain of %p",
    (host, expected) => {
      expect(registrableDomain(host)).toBe(expected)
    },
  )

  test.each(vectors.packagePrefix.map((vector) => [vector.host, vector.expected] as const))(
    "finds the package prefix of %p",
    (host, expected) => {
      expect(packagePrefixForHost(host)).toBe(expected)
    },
  )

  test.each(vectors.localNetwork.map((vector) => [vector.host, vector.expected] as const))(
    "knows whether %p is local",
    (host, expected) => {
      expect(isLocalNetworkHost(host)).toBe(expected)
    },
  )

  test.each(vectors.domainRule.map((vector) => [vector.packageName, vector.url, vector.allowed] as const))(
    "applies the domain rule to %p from %p",
    (packageName, url, allowed) => {
      expect(isPackageNameAllowedForUrl(packageName, url)).toBe(allowed)
    },
  )
})
