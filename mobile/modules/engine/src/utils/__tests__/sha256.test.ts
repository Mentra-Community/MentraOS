/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {createIncrementalSha256, sha256Hex} from "../sha256"

describe("sha256Hex", () => {
  test("matches standard SHA-256 vectors", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })

  test("produces the same digest across arbitrary stream chunk boundaries", async () => {
    const bytes = new TextEncoder().encode("streamed miniapp content".repeat(257))
    const hash = createIncrementalSha256()
    for (let offset = 0; offset < bytes.byteLength; offset += 37) hash.update(bytes.subarray(offset, offset + 37))
    expect(hash.digestHex()).toBe(await sha256Hex(bytes))
  })

  test("incremental fallback matches a standard SHA-256 vector", () => {
    const hash = createIncrementalSha256()
    hash.update(new TextEncoder().encode("a"))
    hash.update(new TextEncoder().encode("bc"))
    expect(hash.digestHex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })
})
