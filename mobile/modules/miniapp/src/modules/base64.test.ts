import {describe, expect, it} from "bun:test"

import {base64ToBytes, bytesToBase64, toUint8Array} from "./base64"

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

describe("base64 codec", () => {
  it("matches known RFC 4648 vectors (encode)", () => {
    expect(bytesToBase64(enc(""))).toBe("")
    expect(bytesToBase64(enc("f"))).toBe("Zg==")
    expect(bytesToBase64(enc("fo"))).toBe("Zm8=")
    expect(bytesToBase64(enc("foo"))).toBe("Zm9v")
    expect(bytesToBase64(enc("foob"))).toBe("Zm9vYg==")
    expect(bytesToBase64(enc("fooba"))).toBe("Zm9vYmE=")
    expect(bytesToBase64(enc("foobar"))).toBe("Zm9vYmFy")
  })

  it("matches known vectors (decode)", () => {
    expect(dec(base64ToBytes("Zg=="))).toBe("f")
    expect(dec(base64ToBytes("Zm8="))).toBe("fo")
    expect(dec(base64ToBytes("Zm9v"))).toBe("foo")
    expect(dec(base64ToBytes("Zm9vYg=="))).toBe("foob")
    expect(dec(base64ToBytes("Zm9vYmE="))).toBe("fooba")
    expect(dec(base64ToBytes("Zm9vYmFy"))).toBe("foobar")
  })

  it("round-trips every byte value (0..255)", () => {
    const all = new Uint8Array(256)
    for (let i = 0; i < 256; i++) all[i] = i
    const back = base64ToBytes(bytesToBase64(all))
    expect(back.length).toBe(256)
    for (let i = 0; i < 256; i++) expect(back[i]).toBe(i)
  })

  it("round-trips binary at every length boundary (padding edges)", () => {
    for (let n = 0; n < 300; n++) {
      const buf = new Uint8Array(n)
      for (let i = 0; i < n; i++) buf[i] = (i * 31 + 7) & 0xff
      const back = base64ToBytes(bytesToBase64(buf))
      expect(back.length).toBe(n)
      for (let i = 0; i < n; i++) expect(back[i]).toBe(buf[i])
    }
  })

  it("decode tolerates whitespace/newlines and missing padding", () => {
    expect(dec(base64ToBytes("Zm9v\nYmFy"))).toBe("foobar")
    expect(dec(base64ToBytes("  Zm9vYmFy  "))).toBe("foobar")
    expect(dec(base64ToBytes("Zm9vYg"))).toBe("foob") // no padding
  })

  it("toUint8Array accepts ArrayBuffer, Uint8Array, and views", () => {
    const ab = new ArrayBuffer(4)
    new Uint8Array(ab).set([1, 2, 3, 4])
    expect(Array.from(toUint8Array(ab))).toEqual([1, 2, 3, 4])
    const u8 = new Uint8Array([5, 6, 7])
    expect(toUint8Array(u8)).toBe(u8)
    const view = new Uint8Array(ab, 1, 2)
    expect(Array.from(toUint8Array(view))).toEqual([2, 3])
  })

  it("encode accepts ArrayBuffer directly", () => {
    const ab = enc("foobar").buffer
    expect(bytesToBase64(ab)).toBe("Zm9vYmFy")
  })
})
