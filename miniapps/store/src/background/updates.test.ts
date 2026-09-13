/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import type {InstalledApp, StoreApp} from "../shared/types"
import {isAutomaticUpdateCandidate} from "./updates"

const storePackageName = "com.mentra.store"

function installed(overrides: Partial<InstalledApp> = {}): InstalledApp {
  return {
    packageName: "com.example.weather",
    visibility: "public",
    name: "Weather",
    version: "1.0.0",
    running: false,
    system: false,
    compatibility: {isCompatible: true, warnings: []},
    ...overrides,
  }
}

function app(overrides: Partial<StoreApp> = {}): StoreApp {
  return {
    packageName: "com.example.weather",
    name: "Weather",
    subtitle: null,
    description: null,
    categories: [],
    privacyPolicyUrl: null,
    supportUrl: null,
    websiteUrl: null,
    reviewTier: "community",
    featured: false,
    iconUrl: null,
    coverUrl: null,
    screenshotUrls: [],
    selectedTrack: "stable",
    preferredTrack: "stable",
    betaAccess: null,
    availableTracks: ["stable"],
    release: {
      id: "release-2",
      version: "2.0.0",
      track: "stable",
      installable: true,
      bundleUrl: "https://store.example/weather-2.0.0.zip",
      bundleSha256: "a".repeat(64),
      manifestSha256: null,
      publishedAt: null,
      permissions: [],
      hardwareRequirements: [],
      minHostVersion: null,
      sdkVersion: "0.3.0",
      installCompatibility: {compatible: true},
    },
    ...overrides,
  }
}

describe("automatic Store updates", () => {
  test("updates releases owned by this Store", () => {
    expect(
      isAutomaticUpdateCandidate(app(), installed({storeOwnerPackageName: storePackageName}), storePackageName),
    ).toBe(true)
  })

  test("updates compatible SYSTEM bundles even before their first Store update", () => {
    expect(
      isAutomaticUpdateCandidate(
        app(),
        installed({system: true, systemStoreOwnerPackageName: storePackageName}),
        storePackageName,
      ),
    ).toBe(true)
  })

  test("does not enqueue a SYSTEM package assigned to another Store", () => {
    expect(
      isAutomaticUpdateCandidate(
        app(),
        installed({system: true, systemStoreOwnerPackageName: "com.some-oem.store"}),
        storePackageName,
      ),
    ).toBe(false)
  })

  test("defers incompatible updates until the host becomes compatible", () => {
    const incompatible = app({
      release: {
        ...app().release,
        installCompatibility: {compatible: false, blocker: "host", reason: "Requires a newer host"},
      },
    })
    expect(
      isAutomaticUpdateCandidate(
        incompatible,
        installed({system: true, systemStoreOwnerPackageName: storePackageName}),
        storePackageName,
      ),
    ).toBe(false)
  })

  test("does not enqueue a beta offer before enrollment", () => {
    const offer = app({
      release: {...app().release, installable: false, bundleUrl: null, bundleSha256: null},
    })
    expect(
      isAutomaticUpdateCandidate(offer, installed({storeOwnerPackageName: storePackageName}), storePackageName),
    ).toBe(false)
  })

  test("does not update unrelated, current, or Store-self releases", () => {
    expect(isAutomaticUpdateCandidate(app(), installed(), storePackageName)).toBe(false)
    expect(isAutomaticUpdateCandidate(app(), installed({version: "2.0.0", system: true}), storePackageName)).toBe(false)
    expect(
      isAutomaticUpdateCandidate(
        app({packageName: storePackageName}),
        installed({packageName: storePackageName, system: true}),
        storePackageName,
      ),
    ).toBe(false)
  })
})
