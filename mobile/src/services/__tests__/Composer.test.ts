// Test the miniapp.json schema validation logic
// (extracted from Composer since full Composer requires expo-file-system)

const ALLOWED_PERMISSIONS = [
  "MICROPHONE",
  "CAMERA",
  "CALENDAR",
  "LOCATION",
  "BACKGROUND_LOCATION",
  "READ_NOTIFICATIONS",
  "POST_NOTIFICATIONS",
] as const

function validateMiniappManifest(manifest: unknown): {valid: boolean; errors: string[]} {
  const errors: string[] = []
  if (!manifest || typeof manifest !== "object") {
    return {valid: false, errors: ["Manifest must be a non-null object"]}
  }
  const m = manifest as Record<string, unknown>
  if (!m.packageName || typeof m.packageName !== "string") errors.push("packageName is required (string)")
  if (!m.version || typeof m.version !== "string") errors.push("version is required (string)")
  if (!m.name || typeof m.name !== "string") errors.push("name is required (string)")
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) {
      errors.push("permissions must be an array")
    } else {
      for (const perm of m.permissions) {
        if (typeof perm !== "string" || !ALLOWED_PERMISSIONS.includes(perm as any)) {
          errors.push(`Invalid permission: ${perm}`)
        }
      }
    }
  }
  return {valid: errors.length === 0, errors}
}

describe("miniapp.json validation", () => {
  test("valid manifest passes", () => {
    const result = validateMiniappManifest({
      packageName: "com.test.app",
      version: "1.0.0",
      name: "Test App",
      permissions: ["MICROPHONE", "CAMERA"],
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  test("missing packageName fails", () => {
    const result = validateMiniappManifest({version: "1.0.0", name: "Test"})
    expect(result.valid).toBe(false)
    expect(result.errors).toContain("packageName is required (string)")
  })

  test("missing version fails", () => {
    const result = validateMiniappManifest({packageName: "com.test", name: "Test"})
    expect(result.valid).toBe(false)
  })

  test("missing name fails", () => {
    const result = validateMiniappManifest({packageName: "com.test", version: "1.0.0"})
    expect(result.valid).toBe(false)
  })

  test("invalid permission rejected", () => {
    const result = validateMiniappManifest({
      packageName: "com.test",
      version: "1.0.0",
      name: "Test",
      permissions: ["MICROPHONE", "INVALID_PERM"],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("INVALID_PERM"))).toBe(true)
  })

  test("ALL permission rejected (internal only)", () => {
    const result = validateMiniappManifest({
      packageName: "com.test",
      version: "1.0.0",
      name: "Test",
      permissions: ["ALL"],
    })
    expect(result.valid).toBe(false)
  })

  test("empty permissions array is valid", () => {
    const result = validateMiniappManifest({
      packageName: "com.test",
      version: "1.0.0",
      name: "Test",
      permissions: [],
    })
    expect(result.valid).toBe(true)
  })

  test("omitted permissions is valid", () => {
    const result = validateMiniappManifest({
      packageName: "com.test",
      version: "1.0.0",
      name: "Test",
    })
    expect(result.valid).toBe(true)
  })

  test("null manifest rejected", () => {
    expect(validateMiniappManifest(null).valid).toBe(false)
  })

  test("non-object manifest rejected", () => {
    expect(validateMiniappManifest("string").valid).toBe(false)
    expect(validateMiniappManifest(123).valid).toBe(false)
  })
})
