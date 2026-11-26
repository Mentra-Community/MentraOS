/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {checkManifestVersions} from "../manifestVersionGate"

/**
 * The rule every install, update and launch refuses by: `minHostVersion` (the only rule apps released before API
 * levels check) and the Miniapp SDK API level the bundle was built with, within the levels this host runs.
 */
describe("checkManifestVersions", () => {
  const hostVersion = "1.42.0"
  const apiLevels = {current: 3, oldest: 2}

  test("a manifest without fields passes, built before API levels (level 1)", () => {
    expect(checkManifestVersions({}, {hostVersion}).ok).toBe(true)
    expect(checkManifestVersions(null, {hostVersion}).ok).toBe(true)
  })

  test("minHostVersion above the host's version is refused; at or below it, accepted", () => {
    expect(checkManifestVersions({minHostVersion: "1.42.0"}, {hostVersion}).ok).toBe(true)
    expect(checkManifestVersions({minHostVersion: "1.45.0"}, {hostVersion})).toEqual({
      ok: false,
      blocker: "host",
      reason: "Requires Mentra App 1.45.0+; this host is 1.42.0.",
    })
  })

  test("a level above the host's current one is refused: update the app", () => {
    expect(checkManifestVersions({minApiLevel: 4}, {apiLevels})).toMatchObject({ok: false, blocker: "host"})
    expect(checkManifestVersions({minApiLevel: 3}, {apiLevels}).ok).toBe(true)
  })

  test("a level below the host's oldest one is refused: update the miniapp", () => {
    expect(checkManifestVersions({minApiLevel: 1}, {apiLevels})).toMatchObject({ok: false, blocker: "sdk"})
    // A manifest from before levels is level 1.
    expect(checkManifestVersions({}, {apiLevels})).toMatchObject({ok: false, blocker: "sdk"})
    expect(checkManifestVersions({minApiLevel: 2}, {apiLevels}).ok).toBe(true)
  })

  test("rejects malformed compatibility fields from untrusted Store metadata", () => {
    expect(checkManifestVersions({minHostVersion: "latest"}, {hostVersion})).toEqual({
      ok: false,
      blocker: "host",
      reason: "Invalid minimum Mentra App version: latest.",
    })
    expect(checkManifestVersions({minApiLevel: 2.5}, {hostVersion})).toMatchObject({ok: false, blocker: "host"})
  })
})
