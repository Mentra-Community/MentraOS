import {preflightMiniappZip} from "./miniappZipPreflight"

function centralDirectoryZip(entries: Array<{name: string; localName?: string; expandedBytes?: number}>): Uint8Array {
  const encoder = new TextEncoder()
  const names = entries.map((entry) => encoder.encode(entry.name))
  const localNames = entries.map((entry) => encoder.encode(entry.localName ?? entry.name))
  const localSize = localNames.reduce((total, name) => total + 30 + name.byteLength, 0)
  const centralSize = names.reduce((total, name) => total + 46 + name.byteLength, 0)
  const bytes = new Uint8Array(localSize + centralSize + 22)
  const view = new DataView(bytes.buffer)
  let offset = 0
  const localOffsets: number[] = []
  entries.forEach((entry, index) => {
    const name = localNames[index]
    localOffsets.push(offset)
    view.setUint32(offset, 0x04034b50, true)
    view.setUint16(offset + 8, 8, true)
    view.setUint32(offset + 22, entry.expandedBytes ?? 1, true)
    view.setUint16(offset + 26, name.byteLength, true)
    bytes.set(name, offset + 30)
    offset += 30 + name.byteLength
  })
  const centralOffset = offset
  entries.forEach((entry, index) => {
    const name = names[index]
    view.setUint32(offset, 0x02014b50, true)
    view.setUint16(offset + 10, 8, true)
    view.setUint32(offset + 24, entry.expandedBytes ?? 1, true)
    view.setUint16(offset + 28, name.byteLength, true)
    view.setUint32(offset + 42, localOffsets[index], true)
    bytes.set(name, offset + 46)
    offset += 46 + name.byteLength
  })
  view.setUint32(offset, 0x06054b50, true)
  view.setUint16(offset + 8, entries.length, true)
  view.setUint16(offset + 10, entries.length, true)
  view.setUint32(offset + 12, centralSize, true)
  view.setUint32(offset + 16, centralOffset, true)
  return bytes
}

describe("managed miniapp ZIP preflight", () => {
  it("accepts ordinary flat bundle paths", () => {
    expect(() =>
      preflightMiniappZip(centralDirectoryZip([{name: "miniapp.json"}, {name: "build/index.js"}])),
    ).not.toThrow()
  })

  it.each(["../escape", "/absolute", "C:/windows", "nested\\windows"])("rejects unsafe path %s", (name) => {
    expect(() => preflightMiniappZip(centralDirectoryZip([{name}]))).toThrow("unsafe path")
  })

  it("rejects duplicate paths and oversized expansion", () => {
    expect(() => preflightMiniappZip(centralDirectoryZip([{name: "same"}, {name: "same"}]))).toThrow("duplicate path")
    expect(() => preflightMiniappZip(centralDirectoryZip([{name: "huge", expandedBytes: 33 * 1024 * 1024}]))).toThrow(
      "oversized file",
    )
  })

  it("rejects a local filename that differs from the safe central-directory name", () => {
    expect(() => preflightMiniappZip(centralDirectoryZip([{name: "safe.js", localName: "../bad"}]))).toThrow(
      "local filename",
    )
  })
})
