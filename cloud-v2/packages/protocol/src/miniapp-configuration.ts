/**
 * @fileoverview Managed miniapp settings: what a miniapp declares in its `miniapp.json` `configuration`, the values
 * each layer gives it, and how they merge (design: design_docs/platform/enterprise/managed-miniapp-settings/spec.md).
 *
 * Layers, lowest first: **shipped** (each key's `default`, in the bundle), **deployment** (the manifest's
 * `miniapps.configuration`, or Core's on Mentra's clouds), **workspace** (an admin's values on the miniapp's Fleet
 * assignment). A key takes the highest layer its `setBy` allows; a `merge: "append"` list takes every allowed layer's
 * items, lowest first, each tagged with its layer as `source`. The person's own values are the miniapp's to keep.
 *
 * MFM checks the values an admin saves, the engine checks every layer against the installed bundle's declaration,
 * and both use the functions here.
 */
import {z} from "zod"

export type ConfigurationLayer = "shipped" | "deployment" | "workspace"
/** The layers above `shipped` a key may name in `setBy`; `person` lets the miniapp offer the person their own. */
export type ConfigurationSetter = "deployment" | "workspace" | "person"

export const CONFIGURATION_LIMITS = {
  maxEntries: 32,
  maxFields: 16,
  maxListItems: 100,
  maxStringBytes: 2_048,
  /** A file as MFM stores it: Core forwards requests of at most 1 MiB, and a file travels as base64 in JSON. */
  maxFileBytes: 700 * 1024,
  maxFilesPerAssignment: 20,
} as const

/** A file value: the engine stores its bytes in the miniapp's blob store as `configurationFileKey(sha256)`. */
export interface ConfigurationFile {
  name: string
  type: string
  size: number
  sha256: string
}

export const ConfigurationFileSchema: z.ZodType<ConfigurationFile> = z
  .object({
    name: z.string().min(1).max(200),
    type: z.string().max(200),
    size: z.number().int().min(0).max(CONFIGURATION_LIMITS.maxFileBytes),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

/** The blob key a configuration file is kept under in its miniapp's store. */
export function configurationFileKey(sha256: string): string {
  return `configuration/${sha256}`
}

const KEY = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/)
const LABEL = z.string().min(1).max(100)

const fieldBase = {
  key: KEY,
  label: LABEL.optional(),
  description: z.string().max(500).optional(),
}

const ScalarFieldSchema = z.discriminatedUnion("type", [
  z.object({...fieldBase, type: z.literal("string"), maxLength: z.number().int().min(1).max(2_048).optional()}).strict(),
  z.object({...fieldBase, type: z.literal("url")}).strict(),
  z.object({...fieldBase, type: z.literal("number")}).strict(),
  z.object({...fieldBase, type: z.literal("boolean")}).strict(),
  z.object({...fieldBase, type: z.literal("choice"), options: z.array(z.string().min(1).max(200)).min(1).max(100)}).strict(),
  z
    .object({
      ...fieldBase,
      type: z.literal("file"),
      /** MIME types or extensions (`.xlsx`), as an `<input accept>` takes them. */
      accept: z.array(z.string().min(1).max(200)).max(20).optional(),
      maxBytes: z.number().int().min(1).max(CONFIGURATION_LIMITS.maxFileBytes).optional(),
    })
    .strict(),
])

export type ConfigurationField = z.infer<typeof ScalarFieldSchema>

const entryExtras = {
  setBy: z.array(z.enum(["deployment", "workspace", "person"])).max(3).optional(),
  default: z.unknown().optional(),
}

const ListEntrySchema = z
  .object({
    ...fieldBase,
    ...entryExtras,
    type: z.literal("list"),
    merge: z.enum(["replace", "append"]).optional(),
    fields: z
      .array(ScalarFieldSchema)
      .min(1)
      .max(CONFIGURATION_LIMITS.maxFields)
      .refine((fields) => fields.every((field) => field.key !== "source"), "`source` is the layer an item came from"),
    maxItems: z.number().int().min(1).max(CONFIGURATION_LIMITS.maxListItems).optional(),
  })
  .strict()

const ScalarEntrySchema = z.union(
  ScalarFieldSchema.options.map((option) => option.extend(entryExtras)) as unknown as [
    z.ZodTypeAny,
    z.ZodTypeAny,
    ...z.ZodTypeAny[],
  ],
)

export type ConfigurationEntry =
  | (ConfigurationField & {setBy?: ConfigurationSetter[]; default?: unknown})
  | z.infer<typeof ListEntrySchema>

/** A `miniapp.json` `configuration`: unique keys, each default valid for its entry. */
export const ConfigurationDeclarationSchema: z.ZodType<ConfigurationEntry[]> = z
  .array(z.union([ListEntrySchema, ScalarEntrySchema]))
  .max(CONFIGURATION_LIMITS.maxEntries)
  .superRefine((entries, ctx) => {
    const keys = new Set<string>()
    for (const [index, entry] of (entries as ConfigurationEntry[]).entries()) {
      if (keys.has(entry.key)) ctx.addIssue({code: "custom", path: [index, "key"], message: "duplicate key"})
      keys.add(entry.key)
      if (entry.default !== undefined && checkValue(entry, entry.default, "shipped") === undefined) {
        ctx.addIssue({code: "custom", path: [index, "default"], message: "default does not match its type"})
      }
    }
  }) as z.ZodType<ConfigurationEntry[]>

export type ConfigurationDeclaration = ConfigurationEntry[]

/** The declaration a `miniapp.json` holds, or null when it has none or it is invalid. */
export function readConfigurationDeclaration(manifest: unknown): ConfigurationDeclaration | null {
  const raw = (manifest as {configuration?: unknown} | null)?.configuration
  if (raw === undefined) return null
  const parsed = ConfigurationDeclarationSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The layers a key may come from above `shipped`. `backendUrl` comes from a deployment only, whatever it says. */
export function setByOf(entry: ConfigurationEntry): ConfigurationSetter[] {
  if (entry.key === "backendUrl") return ["deployment"]
  return entry.setBy ?? ["deployment"]
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function checkScalar(field: ConfigurationField, value: unknown, layer: ConfigurationLayer): unknown {
  switch (field.type) {
    case "string":
      return typeof value === "string" &&
        utf8Bytes(value) <= CONFIGURATION_LIMITS.maxStringBytes &&
        (field.maxLength === undefined || value.length <= field.maxLength)
        ? value
        : undefined
    case "url": {
      if (typeof value !== "string" || utf8Bytes(value) > CONFIGURATION_LIMITS.maxStringBytes) return undefined
      try {
        const url = new URL(value)
        return url.protocol === "https:" && !url.username && !url.password && !url.hash ? value : undefined
      } catch {
        return undefined
      }
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined
    case "boolean":
      return typeof value === "boolean" ? value : undefined
    case "choice":
      return typeof value === "string" && field.options.includes(value) ? value : undefined
    case "file": {
      // A shipped file is a path inside the bundle; the engine does not deliver those yet.
      if (layer === "shipped") return undefined
      const parsed = ConfigurationFileSchema.safeParse(value)
      if (!parsed.success) return undefined
      if (field.maxBytes !== undefined && parsed.data.size > field.maxBytes) return undefined
      return parsed.data
    }
  }
}

/** The value as the entry accepts it from this layer, or undefined when it doesn't match. */
export function checkValue(entry: ConfigurationEntry, value: unknown, layer: ConfigurationLayer): unknown {
  if (entry.type !== "list") return checkScalar(entry, value, layer)
  if (!Array.isArray(value) || value.length > (entry.maxItems ?? CONFIGURATION_LIMITS.maxListItems)) return undefined
  const items: Record<string, unknown>[] = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined
    const record = item as Record<string, unknown>
    if (Object.keys(record).some((key) => !entry.fields.some((field) => field.key === key))) return undefined
    const checked: Record<string, unknown> = {}
    for (const field of entry.fields) {
      if (record[field.key] === undefined) continue
      const fieldValue = checkScalar(field, record[field.key], layer)
      if (fieldValue === undefined) return undefined
      checked[field.key] = fieldValue
    }
    items.push(checked)
  }
  return items
}

/**
 * Check one layer's values against the declaration: only declared keys that layer may set, each of the right type.
 * `rejected` names the keys left out.
 */
export function checkLayer(
  declaration: ConfigurationDeclaration,
  values: Readonly<Record<string, unknown>>,
  layer: Exclude<ConfigurationLayer, "shipped">,
): {values: Record<string, unknown>; rejected: string[]} {
  const checked: Record<string, unknown> = {}
  const rejected: string[] = []
  for (const [key, value] of Object.entries(values)) {
    const entry = declaration.find((item) => item.key === key)
    const accepted = entry && setByOf(entry).includes(layer) ? checkValue(entry, value, layer) : undefined
    if (accepted === undefined) rejected.push(key)
    else checked[key] = accepted
  }
  return {values: checked, rejected}
}

export interface MergedConfiguration {
  values: Record<string, unknown>
  /** The layer each key's value came from; an appended list's items carry theirs as `source`. */
  sources: Record<string, ConfigurationLayer>
  /** By layer, the keys that layer set and the declaration refused. */
  rejected: Partial<Record<ConfigurationLayer, string[]>>
}

/**
 * The values a miniapp reads. Without a declaration (a bundle from before it), the deployment's string values pass
 * as they are, which is what Mentra Apps before managed settings handed every miniapp, and nothing else does.
 */
export function mergeConfiguration(
  declaration: ConfigurationDeclaration | null,
  layers: {deployment?: Readonly<Record<string, unknown>>; workspace?: Readonly<Record<string, unknown>>},
): MergedConfiguration {
  const values: Record<string, unknown> = {}
  const sources: Record<string, ConfigurationLayer> = {}
  const rejected: MergedConfiguration["rejected"] = {}
  if (!declaration) {
    for (const [key, value] of Object.entries(layers.deployment ?? {})) {
      if (typeof value !== "string") continue
      values[key] = value
      sources[key] = "deployment"
    }
    return {values, sources, rejected}
  }
  const checked: Partial<Record<ConfigurationLayer, Record<string, unknown>>> = {}
  for (const layer of ["deployment", "workspace"] as const) {
    const given = layers[layer]
    if (!given) continue
    const result = checkLayer(declaration, given, layer)
    checked[layer] = result.values
    if (result.rejected.length > 0) rejected[layer] = result.rejected
  }
  for (const entry of declaration) {
    const shipped = entry.default === undefined ? undefined : checkValue(entry, entry.default, "shipped")
    const byLayer: [ConfigurationLayer, unknown][] = [
      ["shipped", shipped],
      ["deployment", checked.deployment?.[entry.key]],
      ["workspace", checked.workspace?.[entry.key]],
    ]
    const present = byLayer.filter(([, value]) => value !== undefined)
    if (present.length === 0) continue
    if (entry.type === "list" && entry.merge === "append") {
      values[entry.key] = present.flatMap(([layer, items]) =>
        (items as Record<string, unknown>[]).map((item) => ({...item, source: layer})),
      )
      sources[entry.key] = present[present.length - 1][0]
      continue
    }
    const [layer, value] = present[present.length - 1]
    values[entry.key] = value
    sources[entry.key] = layer
  }
  return {values, sources, rejected}
}

/** Every file a set of values names, by SHA-256. */
export function configurationFiles(
  declaration: ConfigurationDeclaration,
  values: Readonly<Record<string, unknown>>,
): ConfigurationFile[] {
  const files = new Map<string, ConfigurationFile>()
  for (const entry of declaration) {
    const value = values[entry.key]
    if (value === undefined) continue
    if (entry.type === "file") files.set((value as ConfigurationFile).sha256, value as ConfigurationFile)
    if (entry.type !== "list") continue
    for (const item of value as Record<string, unknown>[]) {
      for (const field of entry.fields) {
        if (field.type === "file" && item[field.key]) {
          const file = item[field.key] as ConfigurationFile
          files.set(file.sha256, file)
        }
      }
    }
  }
  return [...files.values()]
}
