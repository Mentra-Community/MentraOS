// Pure manifest mutation helpers. No I/O. Returns new manifest objects.
//
// Used by the object-verb subcommands (`permission add`, `hardware add`, etc.)
// and the interactive `mentra-miniapp manifest` wizard. Both surfaces share
// these primitives so behavior is identical.

import {
  ALLOWED_HARDWARE_LEVELS,
  ALLOWED_HARDWARE_TYPES,
  ALLOWED_PERMISSIONS,
  AllowedHardwareLevel,
  AllowedHardwareType,
  AllowedPermission,
  ManifestHardwareRequirement,
  ManifestPermission,
  MiniappManifestV1,
} from "./manifest.js"

export type Manifest = MiniappManifestV1 & Record<string, unknown>

export interface ManifestMutateError {
  code:
    | "unknown_type"
    | "duplicate"
    | "invalid_level"
    | "not_present"
  message: string
  /** For `unknown_type`: the closest allowed value by Levenshtein distance, if any. */
  closestMatch?: string
}

export class MutateError extends Error {
  readonly info: ManifestMutateError
  constructor(info: ManifestMutateError) {
    super(info.message)
    this.name = "MutateError"
    this.info = info
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export function listPermissions(m: Manifest): ManifestPermission[] {
  return [...(m.permissions ?? [])]
}

export function addPermission(
  m: Manifest,
  type: string,
  opts?: {description?: string; required?: boolean},
): Manifest {
  const validated = validatePermissionType(type)
  const existing = m.permissions ?? []
  if (existing.some((p) => p.type === validated)) {
    throw new MutateError({
      code: "duplicate",
      message: `${validated} is already declared. Use 'mentra-miniapp permission remove ${validated}' first if you want to update its description / required flag.`,
    })
  }
  const entry: ManifestPermission = {type: validated}
  if (opts?.description !== undefined) entry.description = opts.description
  if (opts?.required !== undefined) entry.required = opts.required
  return {...m, permissions: [...existing, entry]}
}

export function removePermission(m: Manifest, type: string): Manifest {
  const validated = validatePermissionType(type)
  const existing = m.permissions ?? []
  if (!existing.some((p) => p.type === validated)) {
    throw new MutateError({
      code: "not_present",
      message: `${validated} is not declared. Currently declared: ${existing.map((p) => p.type).join(", ") || "(none)"}.`,
    })
  }
  return {...m, permissions: existing.filter((p) => p.type !== validated)}
}

// ---------------------------------------------------------------------------
// Hardware
// ---------------------------------------------------------------------------

export function listHardware(m: Manifest): ManifestHardwareRequirement[] {
  return [...(m.hardwareRequirements ?? [])]
}

export function addHardware(
  m: Manifest,
  type: string,
  level: string,
  opts?: {description?: string},
): Manifest {
  const validatedType = validateHardwareType(type)
  const validatedLevel = validateHardwareLevel(level)
  const existing = m.hardwareRequirements ?? []
  if (existing.some((h) => h.type === validatedType)) {
    throw new MutateError({
      code: "duplicate",
      message: `${validatedType} hardware requirement already declared. Use 'mentra-miniapp hardware remove ${validatedType}' first if you want to update its level / description.`,
    })
  }
  const entry: ManifestHardwareRequirement = {type: validatedType, level: validatedLevel}
  if (opts?.description !== undefined) entry.description = opts.description
  return {...m, hardwareRequirements: [...existing, entry]}
}

export function removeHardware(m: Manifest, type: string): Manifest {
  const validatedType = validateHardwareType(type)
  const existing = m.hardwareRequirements ?? []
  if (!existing.some((h) => h.type === validatedType)) {
    throw new MutateError({
      code: "not_present",
      message: `${validatedType} hardware requirement is not declared. Currently declared: ${existing.map((h) => h.type).join(", ") || "(none)"}.`,
    })
  }
  return {...m, hardwareRequirements: existing.filter((h) => h.type !== validatedType)}
}

// ---------------------------------------------------------------------------
// Validators (with Levenshtein closest-match suggestions)
// ---------------------------------------------------------------------------

function validatePermissionType(input: string): AllowedPermission {
  const normalized = input.toUpperCase()
  if ((ALLOWED_PERMISSIONS as readonly string[]).includes(normalized)) {
    return normalized as AllowedPermission
  }
  const closest = closestAllowedValue(normalized, ALLOWED_PERMISSIONS)
  throw new MutateError({
    code: "unknown_type",
    message:
      `Unknown permission "${input}".` +
      (closest ? ` Did you mean "${closest}"?` : "") +
      ` Allowed: ${ALLOWED_PERMISSIONS.join(", ")}.`,
    ...(closest ? {closestMatch: closest} : {}),
  })
}

function validateHardwareType(input: string): AllowedHardwareType {
  const normalized = input.toUpperCase()
  if ((ALLOWED_HARDWARE_TYPES as readonly string[]).includes(normalized)) {
    return normalized as AllowedHardwareType
  }
  const closest = closestAllowedValue(normalized, ALLOWED_HARDWARE_TYPES)
  throw new MutateError({
    code: "unknown_type",
    message:
      `Unknown hardware type "${input}".` +
      (closest ? ` Did you mean "${closest}"?` : "") +
      ` Allowed: ${ALLOWED_HARDWARE_TYPES.join(", ")}.`,
    ...(closest ? {closestMatch: closest} : {}),
  })
}

function validateHardwareLevel(input: string): AllowedHardwareLevel {
  const normalized = input.toUpperCase()
  if ((ALLOWED_HARDWARE_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as AllowedHardwareLevel
  }
  const closest = closestAllowedValue(normalized, ALLOWED_HARDWARE_LEVELS)
  throw new MutateError({
    code: "invalid_level",
    message:
      `Invalid hardware level "${input}".` +
      (closest ? ` Did you mean "${closest}"?` : "") +
      ` Allowed: ${ALLOWED_HARDWARE_LEVELS.join(", ")}.`,
    ...(closest ? {closestMatch: closest} : {}),
  })
}

/**
 * Return the closest allowed value to `input` by Levenshtein distance. Threshold
 * of 2 — anything further is too distant to be helpful.
 */
export function closestAllowedValue<T extends string>(
  input: string,
  allowed: readonly T[],
): T | null {
  const upper = input.toUpperCase()
  let best: T | null = null
  let bestDist = Infinity
  for (const candidate of allowed) {
    const d = levenshtein(upper, candidate)
    if (d < bestDist) {
      bestDist = d
      best = candidate
    }
  }
  return bestDist <= 2 ? best : null
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  const prev = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    let curr = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const next = Math.min(curr + 1, prev[j] + 1, prev[j - 1] + cost)
      prev[j - 1] = curr
      curr = next
    }
    prev[b.length] = curr
  }

  return prev[b.length]
}
