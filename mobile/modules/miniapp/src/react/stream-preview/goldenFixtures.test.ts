/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"
import {existsSync, readFileSync} from "node:fs"
import {join} from "node:path"

import {parsePreviewFrame, type PreviewParseError} from "./protocol"

/**
 * The shared `MFPV` fixtures that the Kotlin and Swift parsers also assert against. A drift in any
 * one language fails the same named file in all three suites.
 */
const FIXTURES_DIR = join(import.meta.dir, "../../../../frame-preview/fixtures")
const MANIFEST = join(FIXTURES_DIR, "manifest.json")

interface FixtureEntry {
  file: string
  expect: string
  width?: number
  height?: number
  format?: "i420" | "nv12"
  rotation?: number
  matrix?: "bt601" | "bt709" | "unknown"
  range?: "limited" | "full" | "unknown"
  flags?: number
  generation?: number
  sequence?: number
  payloadLength?: number
  timestampNs?: string
  sentAtNs?: string
  fill?: {y?: number; u?: number; v?: number}
}

function loadFixture(file: string): ArrayBuffer {
  const bytes = readFileSync(join(FIXTURES_DIR, file))
  // A standalone ArrayBuffer, as the transport delivers it: the parser's views must start at 0.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

const manifest: FixtureEntry[] = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : []

describe("shared golden fixtures", () => {
  test("the fixture manifest is present and covers every parser reason code", () => {
    expect(manifest.length).toBeGreaterThan(0)
    const reasons = new Set(manifest.filter((entry) => entry.expect !== "ok").map((entry) => entry.expect))
    expect([...reasons].sort()).toEqual(
      [
        "bad-dimensions",
        "bad-header-length",
        "bad-magic",
        "payload-size-mismatch",
        "short-buffer",
        "truncated-payload",
        "unknown-pixel-format",
        "unsupported-version",
      ].sort(),
    )
  })

  for (const entry of manifest) {
    test(entry.file, () => {
      const result = parsePreviewFrame(loadFixture(entry.file))
      if (entry.expect !== "ok") {
        expect(result.ok).toBe(false)
        expect((result as PreviewParseError).reason).toBe(entry.expect as PreviewParseError["reason"])
        return
      }
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.width).toBe(entry.width!)
      expect(result.height).toBe(entry.height!)
      expect(result.pixelFormat).toBe(entry.format!)
      expect(result.rotationQuarters).toBe(entry.rotation!)
      expect(result.sessionGen).toBe(entry.generation!)
      expect(result.frameSeq).toBe(entry.sequence!)
      expect(result.senderColorFallback).toBe(((entry.flags ?? 0) & 1) === 1)
      if (entry.matrix === "unknown") {
        expect(result.colorMatrixAssumed).toBe(true)
        expect(result.colorMatrix).toBe("bt601")
      } else {
        expect(result.colorMatrixAssumed).toBe(false)
        expect(result.colorMatrix).toBe(entry.matrix!)
      }
      if (entry.range === "unknown") {
        expect(result.colorRangeAssumed).toBe(true)
        expect(result.colorRange).toBe("limited")
      } else {
        expect(result.colorRangeAssumed).toBe(false)
        expect(result.colorRange).toBe(entry.range!)
      }
      if (entry.payloadLength !== undefined) expect(result.payloadLen).toBe(entry.payloadLength)
      if (entry.timestampNs !== undefined) expect(result.timestampNs).toBe(BigInt(entry.timestampNs))
      if (entry.sentAtNs !== undefined) expect(result.sentAtNs).toBe(BigInt(entry.sentAtNs))
      if (entry.fill?.y !== undefined) expect(result.y[0]).toBe(entry.fill.y)
      if (result.pixelFormat === "i420") {
        if (entry.fill?.u !== undefined) expect(result.u[0]).toBe(entry.fill.u)
        if (entry.fill?.v !== undefined) expect(result.v[0]).toBe(entry.fill.v)
      } else {
        if (entry.fill?.u !== undefined) expect(result.uv[0]).toBe(entry.fill.u)
        if (entry.fill?.v !== undefined) expect(result.uv[1]).toBe(entry.fill.v)
      }
    })
  }
})
