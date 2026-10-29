import {describe, expect, test} from "bun:test"

import {
  assertPublisherIdentityPolicy,
  assertUnsignedDevBuildAllowed,
  SignedMiniappDevBuildError,
} from "../publisherIdentityPolicy"

describe("publisher identity policy", () => {
  test("accepts an unsigned bundle for a package that carries no publisher yet", () => {
    // Signing is opt-in, so a developer needs a key only once they have somewhere
    // durable to keep it. Store review, TLS and the pinned SHA-256 carry the rest.
    expect(() => assertPublisherIdentityPolicy({packageName: "com.example.app"})).not.toThrow()
    // First-party packages follow the same rule; there is no bypass.
    expect(() => assertPublisherIdentityPolicy({packageName: "com.mentra.notes"})).not.toThrow()
    expect(() =>
      assertPublisherIdentityPolicy({packageName: "com.mentra.notes", installedFingerprint: "sha256:one"}),
    ).toThrow("Unsigned bundle cannot replace signed miniapp")
  })

  test("records a publisher the first time one appears, then holds the package to it", () => {
    // The opt-in moment: a signed bundle may take over a package that has no
    // recorded publisher, and the caller persists the fingerprint afterwards.
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.example.app",
        candidateFingerprint: "sha256:one",
      }),
    ).not.toThrow()
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.example.app",
        candidateFingerprint: "sha256:one",
        installedFingerprint: "sha256:one",
      }),
    ).not.toThrow()
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.example.app",
        candidateFingerprint: "sha256:two",
        installedFingerprint: "sha256:one",
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
      }),
    ).toThrow("Unsigned bundle cannot replace signed miniapp")
    expect(() =>
      assertPublisherIdentityPolicy({
        packageName: "com.customer.app",
        installedFingerprint: "sha256:one",
      }),
    ).toThrow("Unsigned bundle cannot replace signed miniapp")
  })

  test("holds development builds to the installed signer like any other bundle", () => {
    // A dev build of a package is that package. Unsigned dev code may replace
    // an unsigned install or none, never a signed one.
    expect(() => assertUnsignedDevBuildAllowed({packageName: "com.example.app"})).not.toThrow()
    expect(() =>
      assertUnsignedDevBuildAllowed({packageName: "com.example.app", installedFingerprint: null}),
    ).not.toThrow()
    let refused: unknown
    try {
      assertUnsignedDevBuildAllowed({packageName: "com.example.app", installedFingerprint: "sha256:one"})
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(SignedMiniappDevBuildError)
    expect((refused as SignedMiniappDevBuildError).packageName).toBe("com.example.app")
    expect((refused as Error).message).toBe(
      "com.example.app is installed with a publisher signature. Uninstall it before running a development build.",
    )
  })
})
