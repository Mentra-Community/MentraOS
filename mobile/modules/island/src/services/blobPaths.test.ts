import {describe, expect, it} from "bun:test"

import {extForMime, sanitizeSegment, shareFileName} from "./blobPaths"

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

describe("shareFileName", () => {
  it("keeps a display name that already has an extension (the Recorder case)", () => {
    expect(
      shareFileName({name: "recording-20260627-153012.wav", fileName: "lq3x9-abcd1234ef", mimeType: "audio/wav"}),
    ).toBe("recording-20260627-153012.wav")
  })
  it("appends an extension derived from the mimeType when the name has none", () => {
    expect(shareFileName({name: "My Recording", fileName: "lq3x9-abcd1234ef", mimeType: "audio/wav"})).toBe(
      "My Recording.wav",
    )
  })
  it("falls back to the on-disk id + mime extension when no name is set", () => {
    // This is the bug: without a derived extension the OS would share an
    // extension-less file. We must always produce something with a suffix.
    expect(shareFileName({fileName: "lq3x9-abcd1234ef", mimeType: "audio/wav"})).toBe("lq3x9-abcd1234ef.wav")
  })
  it("strips path separators and illegal characters but keeps spaces/hyphens", () => {
    const out = shareFileName({name: 'a/b\\c:d"e|f?g*h.wav', fileName: "x", mimeType: "audio/wav"})
    expect(out).toBe("a_b_c_d_e_f_g_h.wav")
    expect(out).not.toContain("/")
  })
  it("leaves the name extension-less only when the mime is unknown", () => {
    expect(shareFileName({name: "blob", fileName: "x", mimeType: "application/x-unknown"})).toBe("blob")
  })
})

describe("extForMime", () => {
  it("maps known audio/file mimes to extensions", () => {
    expect(extForMime("audio/wav")).toBe("wav")
    expect(extForMime("audio/x-wav")).toBe("wav")
    expect(extForMime("application/pdf")).toBe("pdf")
    expect(extForMime("image/jpeg")).toBe("jpg")
  })
  it("ignores parameters and casing", () => {
    expect(extForMime("AUDIO/WAV; charset=binary")).toBe("wav")
  })
  it("returns undefined for unknown / empty mimes", () => {
    expect(extForMime("application/octet-stream")).toBeUndefined()
    expect(extForMime("")).toBeUndefined()
  })
})
