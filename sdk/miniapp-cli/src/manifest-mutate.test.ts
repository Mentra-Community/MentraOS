import {describe, expect, test} from "bun:test"
import {
  addHardware,
  addPermission,
  closestAllowedValue,
  listHardware,
  listPermissions,
  Manifest,
  MutateError,
  removeHardware,
  removePermission,
} from "./manifest-mutate.js"
import {ALLOWED_HARDWARE_TYPES, ALLOWED_PERMISSIONS} from "./manifest.js"

const baseManifest = (): Manifest => ({
  packageName: "com.test.app",
  version: "1.0.0",
  name: "Test",
  hardwareRequirements: [],
})

describe("addPermission", () => {
  test("adds a valid permission", () => {
    const m = addPermission(baseManifest(), "MICROPHONE")
    expect(listPermissions(m)).toEqual([{type: "MICROPHONE"}])
  })

  test("normalizes case", () => {
    const m = addPermission(baseManifest(), "microphone")
    expect(listPermissions(m)).toEqual([{type: "MICROPHONE"}])
  })

  test("includes optional description and required", () => {
    const m = addPermission(baseManifest(), "MICROPHONE", {description: "for transcription", required: false})
    expect(listPermissions(m)[0]).toEqual({type: "MICROPHONE", description: "for transcription", required: false})
  })

  test("rejects unknown type with closest-match suggestion", () => {
    let err: MutateError | null = null
    try {
      addPermission(baseManifest(), "MICRPHONE")
    } catch (e) {
      err = e as MutateError
    }
    expect(err).not.toBeNull()
    expect(err!.info.code).toBe("unknown_type")
    expect(err!.info.closestMatch).toBe("MICROPHONE")
    expect(err!.message).toContain('Did you mean "MICROPHONE"?')
  })

  test("rejects gibberish without suggestion", () => {
    let err: MutateError | null = null
    try {
      addPermission(baseManifest(), "QQQQQQQQ")
    } catch (e) {
      err = e as MutateError
    }
    expect(err).not.toBeNull()
    expect(err!.info.code).toBe("unknown_type")
    expect(err!.info.closestMatch).toBeUndefined()
  })

  test("rejects duplicates", () => {
    const m = addPermission(baseManifest(), "MICROPHONE")
    let err: MutateError | null = null
    try {
      addPermission(m, "MICROPHONE")
    } catch (e) {
      err = e as MutateError
    }
    expect(err).not.toBeNull()
    expect(err!.info.code).toBe("duplicate")
  })

  test("does not mutate input manifest", () => {
    const m = baseManifest()
    addPermission(m, "MICROPHONE")
    expect(m.permissions ?? []).toEqual([])
  })
})

describe("removePermission", () => {
  test("removes a present permission", () => {
    let m = addPermission(baseManifest(), "MICROPHONE")
    m = addPermission(m, "CAMERA")
    m = removePermission(m, "MICROPHONE")
    expect(listPermissions(m)).toEqual([{type: "CAMERA"}])
  })

  test("rejects missing permission", () => {
    let err: MutateError | null = null
    try {
      removePermission(baseManifest(), "MICROPHONE")
    } catch (e) {
      err = e as MutateError
    }
    expect(err).not.toBeNull()
    expect(err!.info.code).toBe("not_present")
  })

  test("rejects unknown type", () => {
    let err: MutateError | null = null
    try {
      removePermission(baseManifest(), "BOGUS")
    } catch (e) {
      err = e as MutateError
    }
    expect(err).not.toBeNull()
    expect(err!.info.code).toBe("unknown_type")
  })
})

describe("addHardware", () => {
  test("adds a valid hardware requirement", () => {
    const m = addHardware(baseManifest(), "DISPLAY", "REQUIRED")
    expect(listHardware(m)).toEqual([{type: "DISPLAY", level: "REQUIRED"}])
  })

  test("rejects unknown level with suggestion", () => {
    let err: MutateError | null = null
    try {
      addHardware(baseManifest(), "DISPLAY", "REQURED")
    } catch (e) {
      err = e as MutateError
    }
    expect(err).not.toBeNull()
    expect(err!.info.code).toBe("invalid_level")
    expect(err!.info.closestMatch).toBe("REQUIRED")
  })

  test("rejects unknown type", () => {
    let err: MutateError | null = null
    try {
      addHardware(baseManifest(), "BLUETOOTH", "REQUIRED")
    } catch (e) {
      err = e as MutateError
    }
    expect(err).not.toBeNull()
    expect(err!.info.code).toBe("unknown_type")
  })

  test("rejects duplicates", () => {
    const m = addHardware(baseManifest(), "DISPLAY", "REQUIRED")
    let err: MutateError | null = null
    try {
      addHardware(m, "DISPLAY", "OPTIONAL")
    } catch (e) {
      err = e as MutateError
    }
    expect(err).not.toBeNull()
    expect(err!.info.code).toBe("duplicate")
  })
})

describe("removeHardware", () => {
  test("removes a present hardware requirement", () => {
    let m = addHardware(baseManifest(), "DISPLAY", "REQUIRED")
    m = addHardware(m, "CAMERA", "OPTIONAL")
    m = removeHardware(m, "DISPLAY")
    expect(listHardware(m)).toEqual([{type: "CAMERA", level: "OPTIONAL"}])
  })

  test("rejects missing hardware", () => {
    let err: MutateError | null = null
    try {
      removeHardware(baseManifest(), "DISPLAY")
    } catch (e) {
      err = e as MutateError
    }
    expect(err).not.toBeNull()
    expect(err!.info.code).toBe("not_present")
  })
})

describe("closestAllowedValue", () => {
  test("matches obvious typo", () => {
    expect(closestAllowedValue("MICRPHONE", ALLOWED_PERMISSIONS)).toBe("MICROPHONE")
  })

  test("returns null for distant input", () => {
    expect(closestAllowedValue("QQQQQQQQ", ALLOWED_PERMISSIONS)).toBe(null)
  })

  test("matches case-insensitive", () => {
    expect(closestAllowedValue("microphone", ALLOWED_PERMISSIONS)).toBe("MICROPHONE")
  })

  test("works for hardware types too", () => {
    expect(closestAllowedValue("CAMRA", ALLOWED_HARDWARE_TYPES)).toBe("CAMERA")
  })
})
