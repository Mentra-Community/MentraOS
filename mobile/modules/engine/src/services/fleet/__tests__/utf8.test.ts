/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {utf8ByteLength, utf8Encode} from "../utf8"

const samples = [
  "",
  "abc",
  "café",
  "電話",
  "\u{1F4F1} phone",
  "mixed é電\u{1F4F1} text",
  "\u007f\u0080߿ࠀ￿",
  "lone high \ud800 surrogate",
  "lone low \udc00 surrogate",
  "reversed \udc00\ud800 pair",
]

describe("utf8", () => {
  test("encodes exactly like TextEncoder, including lone surrogates", () => {
    for (const sample of samples) {
      expect([...utf8Encode(sample)]).toEqual([...new TextEncoder().encode(sample)])
    }
  })

  test("measures the encoded length without encoding", () => {
    for (const sample of samples) {
      expect(utf8ByteLength(sample)).toBe(new TextEncoder().encode(sample).length)
    }
  })
})
