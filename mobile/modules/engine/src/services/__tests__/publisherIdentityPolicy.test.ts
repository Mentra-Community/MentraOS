import {describe, expect, test} from "bun:test"

import {assertPublisherIdentityPolicy} from "../publisherIdentityPolicy"

describe("publisher identity policy", () => {
  test("accepts an unsigned bundle for a package that carries no publisher yet", () => {
    // Signing is opt-in, so a developer needs a key only once they have somewhere
    // durable to keep it. Store review, TLS and the pinned SHA-256 carry the rest.
    expect(() =>
      assertPublisherIdentityPolicy({packageName: "com.example.app", system: false}),
    ).not.toThrow()
    // Including a bundled SYSTEM package, while this build ships them unsigned.
    expect(() => assertPublisherIdentityPolicy({packageName: "com.mentra.notes", system: true})).not.toThrow()
  })

  test("records a publisher the first time one appears, then holds the package to it", () => {
    // The opt-in moment: a signed bundle may take over a package that has no
    // recorded publisher, and the caller persists the fingerprint afterwards.
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
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.example.app",
        candidateFingerprint: "sha256:two",
        installedFingerprint: "sha256:one",
        system: false,
      }),
    ).toThrow("Publisher signature mismatch")
  })

  test("refuses to drop a package back to unsigned once it has a publisher", () => {
    // Opting in is one-way: the envelope has no rotation chain, so silently
    // accepting an unsigned successor would erase the identity entirely.
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.example.app",
        installedFingerprint: "sha256:one",
        system: false,
      }),
    ).toThrow("Unsigned bundle cannot replace signed miniapp")
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.customer.app",
        source: "deployment_manifest",
        installedFingerprint: "sha256:one",
        system: false,
      }),
    ).toThrow("Unsigned bundle cannot replace signed miniapp")
  })

  test("holds a SYSTEM package to its build pin only when the build ships one", () => {
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.mentra.notes",
        candidateFingerprint: "sha256:wrong",
        buildPinnedFingerprint: "sha256:expected",
        system: true,
      }),
    ).toThrow("does not match this Mentra App build")
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.mentra.notes",
        candidateFingerprint: "sha256:expected",
        buildPinnedFingerprint: "sha256:expected",
        system: true,
      }),
    ).not.toThrow()
    // A build that pins nothing cannot contradict a signature it never chose.
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.mentra.notes",
        candidateFingerprint: "sha256:anything",
        system: true,
      }),
    ).not.toThrow()
  })

  test("keeps unsigned development snapshots outside production identity", () => {
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.example.app",
        source: "dev_snapshot",
        installedFingerprint: "sha256:one",
        system: false,
      }),
    ).not.toThrow()
  })
})
