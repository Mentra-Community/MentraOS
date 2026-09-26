import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {test} from "node:test"
import {renderDeviceFirmware, validateDeviceFirmware} from "./write-device-firmware.mjs"

const source = JSON.parse(readFileSync(new URL("../device-firmware.json", import.meta.url), "utf8"))

test("all SDK languages carry the same catalogue and the checked-in release has no distribution pin", () => {
  assert.equal(source.nimo.manifest, null)
  const output = renderDeviceFirmware(source)
  const swift = JSON.parse(output.swift.match(/static let json = (.+)\n/)[1])
  const kotlin = JSON.parse(output.kotlin.match(/const val JSON: String = (.+)\n/)[1])
  const typescript = JSON.parse(output.typescript.match(/= ([\s\S]+) as const/)[1])
  assert.deepEqual(JSON.parse(swift), typescript)
  assert.deepEqual(JSON.parse(kotlin), typescript)
  assert.deepEqual(typescript, source)
})

test("invalid source and unsupported compatibility metadata are rejected before generation", () => {
  assert.throws(() => validateDeviceFirmware({...source, schemaVersion: 2}))
  assert.throws(() =>
    validateDeviceFirmware({
      ...source,
      nimo: {...source.nimo, compatible: [{fullVersion: "FW-VERSION-v0.01.1.1-build", packedVersion: "0.01.1.1"}]},
    }),
  )
  assert.throws(() =>
    validateDeviceFirmware({
      ...source,
      nimo: {...source.nimo, manifest: {url: "http://example.invalid", sha256: "a".repeat(64)}},
    }),
  )
  assert.throws(() =>
    validateDeviceFirmware({
      ...source,
      nimo: {...source.nimo, compatible: [{fullVersion: "FW-VERSION-v0.1.1.1-build", packedVersion: "0.1.0.14"}]},
    }),
  )
})
