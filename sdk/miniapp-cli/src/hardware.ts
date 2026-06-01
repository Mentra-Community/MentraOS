// `mentra-miniapp hardware <action>` subcommand handlers. Mirrors permission.ts.

import * as p from "@clack/prompts"
import {ALLOWED_HARDWARE_LEVELS, ALLOWED_HARDWARE_TYPES} from "./manifest.js"
import {
  addHardware,
  listHardware,
  MutateError,
  removeHardware,
  type Manifest,
} from "./manifest-mutate.js"
import {formatLoadError, formatWriteError, loadManifest, writeManifest} from "./manifest-format.js"
import {hardwareDescription} from "./permission-hints.js"

function loadOrExit(): {path: string; manifest: Manifest} {
  const r = loadManifest(process.cwd())
  if (!r.ok) {
    console.error(formatLoadError(r.error))
    process.exit(1)
  }
  return {path: r.value.path, manifest: r.value.manifest}
}

function persistOrExit(path: string, manifest: Manifest): void {
  const w = writeManifest(path, manifest)
  if (!w.ok) {
    console.error(formatWriteError(w.error))
    process.exit(1)
  }
}

function printHardware(manifest: Manifest): void {
  const hw = listHardware(manifest)
  if (hw.length === 0) {
    console.log("Hardware requirements: none declared.")
    return
  }
  console.log(`Hardware requirements (${hw.length}):`)
  for (const h of hw) {
    const desc = h.description ? ` — ${h.description}` : ""
    console.log(`  • ${h.type} (${h.level})${desc}`)
  }
}

export async function listHardwareCmd(): Promise<void> {
  const {manifest} = loadOrExit()
  printHardware(manifest)
}

export async function addHardwareCmd(typeArg?: string, levelArg?: string): Promise<void> {
  const {path, manifest} = loadOrExit()
  let type = typeArg
  let level = levelArg
  let description: string | undefined

  if (!type) {
    p.intro("Add a hardware requirement")
    const declared = new Set(listHardware(manifest).map((h) => h.type))
    const available = ALLOWED_HARDWARE_TYPES.filter((h) => !declared.has(h))
    if (available.length === 0) {
      p.note("All hardware types are already declared. Nothing to add.", "Hardware")
      p.outro("Done")
      return
    }
    const pickedType = await p.select({
      message: "Which hardware?",
      options: available.map((h) => ({value: h, label: h, hint: hardwareDescription(h)})),
    })
    if (p.isCancel(pickedType)) {
      p.cancel("Cancelled.")
      return
    }
    type = pickedType as string

    if (!level) {
      const pickedLevel = await p.select({
        message: "Required or optional?",
        options: ALLOWED_HARDWARE_LEVELS.map((l) => ({
          value: l,
          label: l,
          hint:
            l === "REQUIRED"
              ? "Glasses without this hardware can't run the app"
              : "Glasses without this hardware still run the app (degraded)",
        })),
      })
      if (p.isCancel(pickedLevel)) {
        p.cancel("Cancelled.")
        return
      }
      level = pickedLevel as string
    }

    const desc = await p.text({
      message: "Optional description (how the miniapp uses this hardware):",
      placeholder: "(skip)",
    })
    if (p.isCancel(desc)) {
      p.cancel("Cancelled.")
      return
    }
    if (typeof desc === "string" && desc.trim()) description = desc.trim()
  }

  if (!level) {
    console.error(`Missing level. Usage: mentra-miniapp hardware add ${type} <REQUIRED|OPTIONAL>`)
    process.exit(1)
  }

  let updated: Manifest
  try {
    updated = addHardware(manifest, type!, level!, description !== undefined ? {description} : undefined)
  } catch (e) {
    if (e instanceof MutateError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }

  persistOrExit(path, updated)
  printHardware(updated)
  if (typeArg === undefined) {
    p.outro("Saved miniapp.json ✨")
  }
}

export async function removeHardwareCmd(typeArg?: string): Promise<void> {
  const {path, manifest} = loadOrExit()
  let type = typeArg

  if (!type) {
    const declared = listHardware(manifest)
    if (declared.length === 0) {
      console.log("No hardware requirements declared. Nothing to remove.")
      return
    }
    p.intro("Remove a hardware requirement")
    const picked = await p.select({
      message: "Which hardware to remove?",
      options: declared.map((h) => ({value: h.type, label: `${h.type} (${h.level})`})),
    })
    if (p.isCancel(picked)) {
      p.cancel("Cancelled.")
      return
    }
    type = picked as string
  }

  let updated: Manifest
  try {
    updated = removeHardware(manifest, type!)
  } catch (e) {
    if (e instanceof MutateError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }

  persistOrExit(path, updated)
  printHardware(updated)
}
