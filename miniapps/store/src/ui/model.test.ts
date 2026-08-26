/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import type {InstalledApp, StoreApp} from "../shared/types"
import {filterStoreCategory, isStoreActionDisabled, resolveSelectedApp, selectCompatibleUpdates} from "./model"

function installed(isCompatible: boolean): InstalledApp {
  return {
    packageName: "com.example.weather",
    name: "Weather",
    version: "1.0.0",
    running: false,
    system: false,
    compatibility: {isCompatible, warnings: []},
  }
}

function app(version: string, packageName = "com.example.weather", categories: string[] = []): StoreApp {
  return {
    packageName,
    name: "Weather",
    subtitle: null,
    description: null,
    categories,
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
      id: `release-${version}`,
      version,
      track: "stable",
      bundleUrl: `https://store.example/weather-${version}.zip`,
      bundleSha256: "a".repeat(64),
      manifestSha256: null,
      publishedAt: null,
      permissions: [],
      hardwareRequirements: [],
      minHostVersion: null,
      sdkVersion: null,
    },
  }
}

describe("Store UI model", () => {
  test("allows an update to replace an incompatible installed release", () => {
    const incompatible = installed(false)
    expect(isStoreActionDisabled("install", incompatible)).toBe(false)
    expect(isStoreActionDisabled("open", incompatible)).toBe(true)
  })

  test("blocks an update that requires a newer Mentra App or Miniapp SDK", () => {
    expect(
      isStoreActionDisabled("install", installed(true), {
        compatible: false,
        blocker: "host",
        reason: "requires host >=3.0.0",
      }),
    ).toBe(true)
  })

  test("blocks a new install that requires unavailable glasses hardware", () => {
    expect(
      isStoreActionDisabled("install", undefined, {
        compatible: false,
        blocker: "hardware",
        reason: "camera required",
      }),
    ).toBe(true)
  })

  test("resolves open details from the latest catalog snapshot", () => {
    const original = app("1.0.0")
    const refreshed = app("2.0.0")

    expect(resolveSelectedApp([original], original.packageName)?.release.version).toBe("1.0.0")
    expect(resolveSelectedApp([refreshed], original.packageName)?.release.version).toBe("2.0.0")
    expect(resolveSelectedApp([], original.packageName)).toBeNull()
  })

  test("Update all excludes releases blocked by host, SDK, or hardware compatibility", () => {
    const current = installed(true)
    const compatible = app("2.0.0")
    const blocked = app("3.0.0")
    blocked.release.installCompatibility = {compatible: false, blocker: "sdk", reason: "newer SDK required"}

    expect(selectCompatibleUpdates([compatible, blocked], new Map([[current.packageName, current]]))).toEqual([
      compatible,
    ])
  })

  test("search spans all categories even when a category chip was previously selected", () => {
    const productivity = app("1.0.0", "com.example.notes", ["productivity"])
    const media = app("1.0.0", "com.example.camera", ["media"])

    expect(filterStoreCategory([productivity, media], "productivity", "camera", true)).toEqual([productivity, media])
    expect(filterStoreCategory([productivity, media], "productivity", "", true)).toEqual([productivity])
  })
})
