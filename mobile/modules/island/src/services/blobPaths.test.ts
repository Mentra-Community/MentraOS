import {describe, expect, it} from "bun:test"

import {sanitizeSegment} from "./blobPaths"

describe("sanitizeSegment", () => {
  it("keeps safe chars, replaces the rest", () => {
    expect(sanitizeSegment("com.mentra.recorder")).toBe("com.mentra.recorder")
    expect(sanitizeSegment("a/b\\c")).toBe("a_b_c")
    expect(sanitizeSegment("tok en:123")).toBe("tok_en_123")
  })
  it("never allows traversal / empty segments", () => {
    expect(sanitizeSegment("")).toBe("_")
    expect(sanitizeSegment(".")).toBe("_")
    expect(sanitizeSegment("..")).toBe("_")
    // Dots are legal in filenames; only path separators are stripped, so the
    // result is a single safe filename with no traversal.
    expect(sanitizeSegment("../../etc/passwd")).toBe(".._.._etc_passwd")
    expect(sanitizeSegment("../../etc/passwd")).not.toContain("/")
  })
  it("bounds length", () => {
    expect(sanitizeSegment("x".repeat(500)).length).toBe(120)
  })
})
