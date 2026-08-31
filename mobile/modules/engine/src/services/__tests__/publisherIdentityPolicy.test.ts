import {describe, expect, test} from "bun:test"

import {assertPublisherIdentityPolicy} from "../publisherIdentityPolicy"

describe("publisher identity policy", () => {
  test("accepts a first non-SYSTEM install and a same-signer update", () => {
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.example.app",
        candidateFingerprint: "sha256:one",
        system: false,
      }),
    ).not.toThrow()
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.example.app",
        candidateFingerprint: "sha256:one",
        installedFingerprint: "sha256:one",
        system: false,
      }),
    ).not.toThrow()
  })

  test("rejects a differently signed update", () => {
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.example.app",
        candidateFingerprint: "sha256:two",
        installedFingerprint: "sha256:one",
        system: false,
      }),
    ).toThrow("Publisher signature mismatch")
  })

  test("requires SYSTEM bundles and updates to match the build pin", () => {
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.mentra.notes",
        candidateFingerprint: "sha256:wrong",
        buildPinnedFingerprint: "sha256:expected",
        system: true,
      }),
    ).toThrow("does not match this Mentra App build")
  })

  test("keeps unsigned development snapshots outside production identity", () => {
    expect(() =>
      assertPublisherIdentityPolicy({packageName: "com.example.app", source: "dev_snapshot", system: false}),
    ).not.toThrow()
  })
})
