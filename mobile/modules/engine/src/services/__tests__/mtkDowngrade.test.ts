/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {
  isMtkDowngrade,
  isNewerMtk,
  mtkDowngradeRecordUrl,
  mtkDowngradeTarget,
  resolveMtkDowngrade,
  type MtkDowngrade,
} from "../mtkDowngrade"
import type {VersionJson} from "../OtaUpdateCheckService"

const CURRENT = "MentraLive_20260923.0"
const full = (end: string) => ({end_firmware: end, url: "https://cdn/full.zip", sha256: "a".repeat(64), size: 640339273})
const downgrade = (start: string, end: string): MtkDowngrade => ({
  start_firmware: start,
  end_firmware: end,
  url: `https://mtkfirmware.mentraglass.com/mtk_ota_downgrade_${start.slice(11)}_${end.slice(11)}.zip`,
  sha256: "b".repeat(64),
  size: 15179481,
})
const release30 = (): VersionJson => ({mtk_full_ota: full("MentraLive_20260709")})

describe("mtkDowngradeTarget", () => {
  test("targets the older MTK the manifest pins, never below Mentra 3.0's", () => {
    expect(mtkDowngradeTarget(release30(), CURRENT)).toBe("20260709")
    expect(mtkDowngradeTarget(release30(), "MentraLive_20260709")).toBeNull()
    expect(mtkDowngradeTarget(release30(), "MentraLive_20260626")).toBeNull()
    expect(mtkDowngradeTarget({mtk_full_ota: full("MentraLive_20260626")}, CURRENT)).toBeNull()
    expect(mtkDowngradeTarget({mtk_full_ota: full("MentraLive_20261001.0")}, CURRENT)).toBeNull()
    expect(mtkDowngradeTarget(release30(), undefined)).toBeNull()
  })

  test("without a full OTA, takes the one version every patch ends at", () => {
    const patch = (start: string, end: string) => ({start_firmware: start, end_firmware: end, url: "https://cdn/p.zip"})
    const legacy: VersionJson = {
      mtk_patches: [patch("MentraLive_20260113", "MentraLive_20260709"), patch("MentraLive_20260626", "MentraLive_20260709")],
    }
    expect(mtkDowngradeTarget(legacy, CURRENT)).toBe("20260709")
    legacy.mtk_patches!.push(patch("MentraLive_20260709", "MentraLive_20260801"))
    expect(mtkDowngradeTarget(legacy, CURRENT)).toBeNull()
  })
})

describe("isMtkDowngrade", () => {
  test("requires the exact versions and a complete entry", () => {
    expect(isMtkDowngrade(downgrade(CURRENT, "MentraLive_20260709"), CURRENT, "20260709")).toBe(true)
    expect(isMtkDowngrade(downgrade("MentraLive_20260801", "MentraLive_20260709"), CURRENT, "20260709")).toBe(false)
    expect(isMtkDowngrade(downgrade(CURRENT, "MentraLive_20260626"), CURRENT, "20260626")).toBe(false)
    for (const key of ["url", "sha256", "size"] as const) {
      const invalid: Partial<MtkDowngrade> = downgrade(CURRENT, "MentraLive_20260709")
      delete invalid[key]
      expect(isMtkDowngrade(invalid, CURRENT, "20260709")).toBe(false)
    }
  })
})

describe("resolveMtkDowngrade", () => {
  test("uses the manifest's own downgrade without a lookup", async () => {
    const manifest = {...release30(), mtk_downgrade_patches: [downgrade(CURRENT, "MentraLive_20260709")]}
    const lookups: string[] = []
    const selected = await resolveMtkDowngrade(manifest, CURRENT, async (url) => lookups.push(url))
    expect(selected).toEqual(downgrade(CURRENT, "MentraLive_20260709"))
    expect(lookups).toEqual([])
  })

  test("looks up the published record and adds it for the glasses", async () => {
    const manifest = release30()
    const lookups: string[] = []
    const selected = await resolveMtkDowngrade(manifest, CURRENT, async (url) => {
      lookups.push(url)
      return downgrade(CURRENT, "MentraLive_20260709")
    })
    expect(lookups).toEqual(["https://mtkfirmware.mentraglass.com/mtk_ota_downgrade_20260923.0_20260709.json"])
    expect(selected).toEqual(downgrade(CURRENT, "MentraLive_20260709"))
    expect(manifest.mtk_downgrade_patches).toEqual([downgrade(CURRENT, "MentraLive_20260709")])
  })

  test("keeps the MTK when the record is missing or does not match", async () => {
    for (const fetchRecord of [
      async () => {
        throw new Error("HTTP 404")
      },
      async () => downgrade("MentraLive_20260801", "MentraLive_20260709"),
    ]) {
      const manifest = release30()
      expect(await resolveMtkDowngrade(manifest, CURRENT, fetchRecord)).toBeNull()
      expect(manifest.mtk_downgrade_patches).toBeUndefined()
    }
  })
})

test("versions order by date, then revision", () => {
  expect(isNewerMtk("MentraLive_20260923.0", "MentraLive_20260709")).toBe(true)
  expect(isNewerMtk("20260908.0", "20260908")).toBe(false)
  expect(isNewerMtk("unknown", "20260908")).toBe(false)
  expect(mtkDowngradeRecordUrl(CURRENT, "MentraLive_20260709")).toBe(
    "https://mtkfirmware.mentraglass.com/mtk_ota_downgrade_20260923.0_20260709.json",
  )
})
