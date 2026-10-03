#!/usr/bin/env node
/**
 * Deterministic generator for the shared MFPV golden fixtures.
 *
 * Kotlin, Swift and TypeScript parse the same checked-in files, so a layout drift in any one of
 * them fails the same named fixture. This script is the only writer: it has no randomness, no
 * clock and no dependencies, so running it twice produces identical bytes.
 *
 *   node mobile/modules/frame-preview/fixtures/generate.mjs          # rewrite fixtures
 *   node mobile/modules/frame-preview/fixtures/generate.mjs --check  # fail if files drifted
 *
 * Manifest entries: `file`, `expect` ("ok" or a parser reason code), the header fields as they
 * were written (`width`, `height`, `format`, `rotation`, `matrix`, `range`, `flags`,
 * `generation`, `sequence`), plus `payloadLength`, `timestampNs`/`sentAtNs` (decimal strings,
 * because they exceed 2^53) and `fill`. Payload planes are constant-filled with `fill.y`,
 * `fill.u`, `fill.v`; NV12 interleaves `u, v` pairs. Header fields describe what was written,
 * not what a parser accepts: for a rejected file they only document how it was corrupted.
 */
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from "node:fs"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"

const HEADER_BYTES = 64
const VERSION = 1
const MAGIC = [0x4d, 0x46, 0x50, 0x56]
const FORMAT_CODES = {i420: 1, nv12: 2}
const MATRIX_CODES = {unknown: 0, bt601: 1, bt709: 2}
const RANGE_CODES = {unknown: 0, limited: 1, full: 2}
const FLAG_COLOR_METADATA_FALLBACK = 1

/** Every parser reason code, in the order the parser checks them. */
export const PARSE_REASONS = [
  "short-buffer",
  "bad-magic",
  "unsupported-version",
  "bad-header-length",
  "bad-dimensions",
  "unknown-pixel-format",
  "payload-size-mismatch",
  "truncated-payload",
]

function packedSize(width, height) {
  const cw = Math.ceil(width / 2)
  const ch = Math.ceil(height / 2)
  return width * height + 2 * cw * ch
}

const BASE = {
  width: 16,
  height: 8,
  format: "i420",
  rotation: 0,
  matrix: "bt601",
  range: "limited",
  flags: 0,
  generation: 1,
  sequence: 1,
  timestampNs: "0",
  sentAtNs: "0",
  fill: {y: 0x80, u: 0x40, v: 0xc0},
}

/**
 * Valid frames cover I420 and NV12 at even and odd sizes, all four rotations, every matrix and
 * range code, the colour-fallback flag, a 1x1 frame, and 64-bit timestamps above 2^53.
 */
const VALID = [
  {file: "valid-i420-even-r0-bt601-limited.bin"},
  {
    file: "valid-i420-odd-r1-bt709-full.bin",
    width: 17,
    height: 9,
    rotation: 1,
    matrix: "bt709",
    range: "full",
    generation: 7,
    sequence: 42,
    timestampNs: "123456789",
    sentAtNs: "987654321",
    fill: {y: 0x11, u: 0x22, v: 0x33},
  },
  {
    file: "valid-nv12-even-r2-bt709-limited.bin",
    format: "nv12",
    width: 32,
    height: 18,
    rotation: 2,
    matrix: "bt709",
    range: "limited",
    generation: 3,
    sequence: 1000,
    fill: {y: 0x10, u: 0x70, v: 0x90},
  },
  {
    file: "valid-nv12-odd-r3-bt601-full.bin",
    format: "nv12",
    width: 15,
    height: 7,
    rotation: 3,
    matrix: "bt601",
    range: "full",
    generation: 0xfffffffe,
    sequence: 0xffffffff,
    timestampNs: "72623859790382856",
    sentAtNs: "72623859790382857",
    fill: {y: 0xeb, u: 0x01, v: 0xfe},
  },
  {
    file: "valid-i420-unknown-color-fallback.bin",
    width: 6,
    height: 4,
    matrix: "unknown",
    range: "unknown",
    flags: FLAG_COLOR_METADATA_FALLBACK,
    fill: {y: 0x55, u: 0x66, v: 0x77},
  },
  {
    file: "valid-nv12-1x1-unknown-matrix-limited.bin",
    format: "nv12",
    width: 1,
    height: 1,
    matrix: "unknown",
    range: "limited",
    fill: {y: 0x42, u: 0x24, v: 0x81},
  },
  {
    file: "valid-i420-2x2-bt709-unknown-range.bin",
    width: 2,
    height: 2,
    matrix: "bt709",
    range: "unknown",
    fill: {y: 0x00, u: 0xff, v: 0x7f},
  },
]

/**
 * One file per parser reason. `corrupt` overrides raw header codes or byte counts; `truncateTo`
 * cuts the finished buffer to a length.
 */
const MALFORMED = [
  {file: "reject-short-buffer.bin", expect: "short-buffer", truncateTo: HEADER_BYTES - 1},
  {file: "reject-bad-magic.bin", expect: "bad-magic", corrupt: {magic: [0x4d, 0x46, 0x50, 0x57]}},
  {file: "reject-unsupported-version.bin", expect: "unsupported-version", corrupt: {version: 2}},
  {file: "reject-bad-header-length.bin", expect: "bad-header-length", corrupt: {headerLen: 32}},
  {file: "reject-bad-dimensions-zero-width.bin", expect: "bad-dimensions", width: 0, height: 8},
  {file: "reject-bad-dimensions-oversize.bin", expect: "bad-dimensions", width: 4097, height: 1, corrupt: {payloadBytes: 0}},
  {file: "reject-unknown-pixel-format.bin", expect: "unknown-pixel-format", corrupt: {formatCode: 3}},
  {
    file: "reject-payload-size-mismatch.bin",
    expect: "payload-size-mismatch",
    corrupt: {payloadLen: packedSize(16, 8) + 1, payloadBytes: packedSize(16, 8) + 1},
  },
  {file: "reject-truncated-payload.bin", expect: "truncated-payload", corrupt: {payloadBytes: packedSize(16, 8) - 1}},
]

function buildFrame(spec) {
  const corrupt = spec.corrupt ?? {}
  const width = spec.width
  const height = spec.height
  const payloadLength = corrupt.payloadLen ?? packedSize(width, height)
  const payloadBytes = corrupt.payloadBytes ?? packedSize(width, height)
  const bytes = new Uint8Array(HEADER_BYTES + payloadBytes)
  const view = new DataView(bytes.buffer)
  const magic = corrupt.magic ?? MAGIC
  magic.forEach((byte, index) => view.setUint8(index, byte))
  view.setUint16(4, corrupt.version ?? VERSION, true)
  view.setUint16(6, corrupt.headerLen ?? HEADER_BYTES, true)
  view.setUint32(8, payloadLength, true)
  view.setUint32(12, spec.generation, true)
  view.setUint32(16, spec.sequence, true)
  view.setUint16(20, width, true)
  view.setUint16(22, height, true)
  view.setUint8(24, corrupt.formatCode ?? FORMAT_CODES[spec.format])
  view.setUint8(25, spec.rotation)
  view.setUint8(26, MATRIX_CODES[spec.matrix])
  view.setUint8(27, RANGE_CODES[spec.range])
  view.setUint16(28, spec.flags, true)
  view.setBigInt64(32, BigInt(spec.timestampNs), true)
  view.setBigInt64(40, BigInt(spec.sentAtNs), true)

  const payload = bytes.subarray(HEADER_BYTES)
  const luma = Math.min(width * height, payload.length)
  const chromaPlane = Math.ceil(width / 2) * Math.ceil(height / 2)
  payload.fill(spec.fill.y, 0, luma)
  if (spec.format === "nv12") {
    for (let index = luma; index < payload.length; index += 1) {
      payload[index] = (index - luma) % 2 === 0 ? spec.fill.u : spec.fill.v
    }
  } else {
    payload.fill(spec.fill.u, luma, Math.min(luma + chromaPlane, payload.length))
    payload.fill(spec.fill.v, Math.min(luma + chromaPlane, payload.length))
  }
  return spec.truncateTo === undefined ? bytes : bytes.subarray(0, spec.truncateTo)
}

export function fixtureSpecs() {
  return [
    ...VALID.map((entry) => ({...BASE, ...entry, expect: "ok"})),
    ...MALFORMED.map((entry) => ({...BASE, ...entry})),
  ]
}

function manifestEntry(spec) {
  const corrupt = spec.corrupt ?? {}
  return {
    file: spec.file,
    expect: spec.expect,
    width: spec.width,
    height: spec.height,
    format: spec.format,
    rotation: spec.rotation,
    matrix: spec.matrix,
    range: spec.range,
    flags: spec.flags,
    generation: spec.generation,
    sequence: spec.sequence,
    payloadLength: corrupt.payloadLen ?? packedSize(spec.width, spec.height),
    timestampNs: spec.timestampNs,
    sentAtNs: spec.sentAtNs,
    fill: spec.fill,
  }
}

function render() {
  const specs = fixtureSpecs()
  const covered = new Set(specs.map((spec) => spec.expect))
  for (const reason of PARSE_REASONS) {
    if (!covered.has(reason)) throw new Error(`no fixture for parser reason ${reason}`)
  }
  const files = new Map(specs.map((spec) => [spec.file, buildFrame(spec)]))
  const manifest = `${JSON.stringify(specs.map(manifestEntry), null, 2)}\n`
  return {files, manifest}
}

function main() {
  const dir = dirname(fileURLToPath(import.meta.url))
  const {files, manifest} = render()
  const check = process.argv.includes("--check")
  if (!check) {
    mkdirSync(dir, {recursive: true})
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".bin") && !files.has(name)) throw new Error(`stale fixture ${name}; delete it by hand`)
    }
    for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes)
    writeFileSync(join(dir, "manifest.json"), manifest)
    console.log(`wrote ${files.size} fixtures and manifest.json`)
    return
  }
  const drift = []
  for (const [name, bytes] of files) {
    let onDisk
    try {
      onDisk = readFileSync(join(dir, name))
    } catch {
      drift.push(`${name}: missing`)
      continue
    }
    if (Buffer.compare(onDisk, Buffer.from(bytes)) !== 0) drift.push(`${name}: bytes differ`)
  }
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".bin") && !files.has(name)) drift.push(`${name}: not produced by the generator`)
  }
  if (readFileSync(join(dir, "manifest.json"), "utf8") !== manifest) drift.push("manifest.json: differs")
  if (drift.length > 0) {
    console.error(`fixtures drifted from generate.mjs:\n  ${drift.join("\n  ")}`)
    process.exit(1)
  }
  console.log(`${files.size} fixtures match generate.mjs`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
