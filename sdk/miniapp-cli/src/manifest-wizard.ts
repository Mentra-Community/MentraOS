// `mentra-miniapp manifest` — interactive top-level wizard.
//
// Uses the same mutation backend as the object-verb subcommands, so behavior
// is identical. Loop-driven: read manifest, prompt for an action, mutate,
// persist, loop.

import * as p from "@clack/prompts"
import {ALLOWED_HARDWARE_LEVELS, ALLOWED_HARDWARE_TYPES, ALLOWED_PERMISSIONS} from "./manifest.js"
import {
  addHardware,
  addPermission,
  listHardware,
  listPermissions,
  Manifest,
  MutateError,
  removeHardware,
  removePermission,
} from "./manifest-mutate.js"
import {formatLoadError, formatWriteError, loadManifest, writeManifest} from "./manifest-format.js"
import {hardwareDescription, permissionDescription} from "./permission-hints.js"

export async function runManifestWizard(): Promise<void> {
  p.intro("Mentra miniapp manifest editor")

  const loaded = loadManifest(process.cwd())
  if (!loaded.ok) {
    p.cancel(formatLoadError(loaded.error))
    process.exit(1)
  }
  let {path, manifest} = loaded.value
  // Stage updates locally; persist after each mutation so Ctrl-C never loses
  // a confirmed change. (Matches the spec's note: don't batch.)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let _initialPath = path

  while (true) {
    const action = await p.select({
      message: "What would you like to do?",
      options: [
        {value: "permissions", label: "Edit permissions", hint: `${listPermissions(manifest).length} declared`},
        {value: "hardware", label: "Edit hardware requirements", hint: `${listHardware(manifest).length} declared`},
        {value: "show", label: "Show current manifest"},
        {value: "done", label: "Done"},
      ],
    })
    if (p.isCancel(action) || action === "done") break

    if (action === "show") {
      p.note(JSON.stringify(manifest, null, 2), "miniapp.json")
      continue
    }

    if (action === "permissions") {
      manifest = await editPermissions(manifest)
      const w = writeManifest(path, manifest)
      if (!w.ok) {
        p.cancel(formatWriteError(w.error))
        process.exit(1)
      }
      continue
    }

    if (action === "hardware") {
      manifest = await editHardware(manifest)
      const w = writeManifest(path, manifest)
      if (!w.ok) {
        p.cancel(formatWriteError(w.error))
        process.exit(1)
      }
      continue
    }
  }

  p.outro("Saved miniapp.json ✨")
}

async function editPermissions(manifest: Manifest): Promise<Manifest> {
  const sub = await p.select({
    message: "Permissions",
    options: [
      {value: "add", label: "Add a permission"},
      {value: "remove", label: "Remove a permission"},
      {value: "back", label: "Back"},
    ],
  })
  if (p.isCancel(sub) || sub === "back") return manifest

  if (sub === "add") {
    const declared = new Set(listPermissions(manifest).map((perm) => perm.type))
    const available = ALLOWED_PERMISSIONS.filter((perm) => !declared.has(perm))
    if (available.length === 0) {
      p.note("All permissions are already declared.", "Permissions")
      return manifest
    }
    const picked = await p.multiselect({
      message: "Which permission(s) to add?",
      required: false,
      options: available.map((perm) => ({value: perm, label: perm, hint: permissionDescription(perm)})),
    })
    if (p.isCancel(picked)) return manifest
    let updated = manifest
    for (const type of picked as readonly string[]) {
      const desc = await p.text({
        message: `Description for ${type} (optional):`,
        placeholder: "(skip)",
      })
      if (p.isCancel(desc)) return updated
      const opts = typeof desc === "string" && desc.trim() ? {description: desc.trim()} : undefined
      try {
        updated = addPermission(updated, type, opts)
      } catch (e) {
        if (e instanceof MutateError) {
          p.note(e.message, "Skipped")
        } else {
          throw e
        }
      }
    }
    return updated
  }

  if (sub === "remove") {
    const declared = listPermissions(manifest)
    if (declared.length === 0) {
      p.note("No permissions to remove.", "Permissions")
      return manifest
    }
    const picked = await p.select({
      message: "Which permission to remove?",
      options: declared.map((perm) => ({value: perm.type, label: perm.type})),
    })
    if (p.isCancel(picked)) return manifest
    try {
      return removePermission(manifest, picked as string)
    } catch (e) {
      if (e instanceof MutateError) {
        p.note(e.message, "Skipped")
      }
      return manifest
    }
  }

  return manifest
}

async function editHardware(manifest: Manifest): Promise<Manifest> {
  const sub = await p.select({
    message: "Hardware requirements",
    options: [
      {value: "add", label: "Add a hardware requirement"},
      {value: "remove", label: "Remove a hardware requirement"},
      {value: "back", label: "Back"},
    ],
  })
  if (p.isCancel(sub) || sub === "back") return manifest

  if (sub === "add") {
    const declared = new Set(listHardware(manifest).map((h) => h.type))
    const available = ALLOWED_HARDWARE_TYPES.filter((h) => !declared.has(h))
    if (available.length === 0) {
      p.note("All hardware types are already declared.", "Hardware")
      return manifest
    }
    const type = await p.select({
      message: "Which hardware?",
      options: available.map((h) => ({value: h, label: h, hint: hardwareDescription(h)})),
    })
    if (p.isCancel(type)) return manifest

    const level = await p.select({
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
    if (p.isCancel(level)) return manifest

    const desc = await p.text({
      message: "Description (optional):",
      placeholder: "(skip)",
    })
    if (p.isCancel(desc)) return manifest
    const opts = typeof desc === "string" && desc.trim() ? {description: desc.trim()} : undefined

    try {
      return addHardware(manifest, type as string, level as string, opts)
    } catch (e) {
      if (e instanceof MutateError) p.note(e.message, "Skipped")
      return manifest
    }
  }

  if (sub === "remove") {
    const declared = listHardware(manifest)
    if (declared.length === 0) {
      p.note("No hardware requirements to remove.", "Hardware")
      return manifest
    }
    const picked = await p.select({
      message: "Which hardware to remove?",
      options: declared.map((h) => ({value: h.type, label: `${h.type} (${h.level})`})),
    })
    if (p.isCancel(picked)) return manifest
    try {
      return removeHardware(manifest, picked as string)
    } catch (e) {
      if (e instanceof MutateError) p.note(e.message, "Skipped")
      return manifest
    }
  }

  return manifest
}
