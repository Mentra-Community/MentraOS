/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import type {InstalledApp, StoreApp} from "../shared/types"
import {isStoreActionDisabled, resolveSelectedApp} from "./model"

function installed(isCompatible: boolean): InstalledApp {
  return {
    packageName: "com.example.weather",
    name: "Weather",
    version: "1.0.0",
    running: false,
    compatibility: {isCompatible, warnings: []},
  }
}

function app(version: string): StoreApp {
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
    release: {
      id: `release-${version}`,
      version,
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

  test("resolves open details from the latest catalog snapshot", () => {
    const original = app("1.0.0")
    const refreshed = app("2.0.0")

    expect(resolveSelectedApp([original], original.packageName)?.release.version).toBe("1.0.0")
    expect(resolveSelectedApp([refreshed], original.packageName)?.release.version).toBe("2.0.0")
    expect(resolveSelectedApp([], original.packageName)).toBeNull()
  })
})
