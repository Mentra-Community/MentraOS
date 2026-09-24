/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {checkManifestVersions} from "../manifestVersionGate"

/**
 * Manifest version acceptance gate — `checkManifestVersions`
 * accepts/rejects manifests based on sdkVersion + minHostVersion.
 * The helper is pure (no disk I/O, no React Native deps);
 * AppRegistry's method delegates to it.
 */
describe("checkManifestVersions", () => {
  const supportedSdkRange = "^0.3.0"
  const hostVersion = "1.42.0"

  test("manifest without version fields passes through (legacy)", () => {
    const r = checkManifestVersions({}, {hostVersion, supportedSdkRange})
    expect(r.ok).toBe(true)
  })

  test("null manifest passes through (no install record yet)", () => {
    const r = checkManifestVersions(null, {hostVersion, supportedSdkRange})
    expect(r.ok).toBe(true)
  })

  test("minHostVersion <= hostVersion is accepted", () => {
    const r = checkManifestVersions({minHostVersion: "1.42.0"}, {hostVersion, supportedSdkRange})
    expect(r.ok).toBe(true)
  })

  test("minHostVersion > hostVersion is rejected with a user-facing reason", () => {
    const r = checkManifestVersions({minHostVersion: "1.45.0"}, {hostVersion, supportedSdkRange})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("Requires Mentra App 1.45.0")
      expect(r.reason).toContain("host is 1.42.0")
    }
  })

  test("sdkVersion within supported range is accepted", () => {
    const r = checkManifestVersions({sdkVersion: "0.3.0"}, {hostVersion, supportedSdkRange})
    expect(r.ok).toBe(true)
  })

  test("sdkVersion outside supported range is rejected", () => {
    const r = checkManifestVersions({sdkVersion: "0.2.0"}, {hostVersion, supportedSdkRange})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("SDK 0.2.0")
      expect(r.reason).toContain("^0.3.0")
    }
  })

  test("both sdkVersion + minHostVersion checked; first failure wins", () => {
    const r = checkManifestVersions({sdkVersion: "0.3.0", minHostVersion: "2.0.0"}, {hostVersion, supportedSdkRange})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("Mentra App")
  })

  test("semver-coerced shorthand versions are accepted (0.3 → 0.3.0)", () => {
    const r = checkManifestVersions({sdkVersion: "0.3"}, {hostVersion, supportedSdkRange})
    expect(r.ok).toBe(true)
  })

  test("rejects malformed compatibility fields from untrusted Store metadata", () => {
    const r = checkManifestVersions({sdkVersion: "garbage"}, {hostVersion, supportedSdkRange})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("Invalid Mentra Miniapp SDK version")
  })
})
