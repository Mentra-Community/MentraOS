/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {sha256Hex} from "../sha256"

describe("sha256Hex", () => {
  test("matches standard SHA-256 vectors", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })
})
