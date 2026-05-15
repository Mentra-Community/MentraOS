// `mentra-miniapp permission <action>` subcommand handlers.
//
// Object-verb surface for the most common manifest edit. Both interactive
// (no type arg → clack prompts) and non-interactive (type arg given) flows.
// Shares mutation backend with the wizard via manifest-mutate.ts.

import * as p from "@clack/prompts"
import {ALLOWED_PERMISSIONS} from "./manifest.js"
import {
  addPermission,
  listPermissions,
  MutateError,
  removePermission,
  type Manifest,
} from "./manifest-mutate.js"
import {formatLoadError, formatWriteError, loadManifest, writeManifest} from "./manifest-format.js"
import {permissionDescription} from "./permission-hints.js"

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

function printPermissions(manifest: Manifest): void {
  const perms = listPermissions(manifest)
  if (perms.length === 0) {
    console.log("Permissions: none declared.")
    return
  }
  console.log(`Permissions (${perms.length}):`)
  for (const perm of perms) {
    const desc = perm.description ? ` — ${perm.description}` : ""
    const req = perm.required === false ? " [optional]" : ""
    console.log(`  • ${perm.type}${req}${desc}`)
  }
}

export async function listPermissionsCmd(): Promise<void> {
  const {manifest} = loadOrExit()
  printPermissions(manifest)
}

export async function addPermissionCmd(typeArg?: string): Promise<void> {
  const {path, manifest} = loadOrExit()
  let type = typeArg
  let description: string | undefined

  if (!type) {
    p.intro("Add a permission")
    const declared = new Set(listPermissions(manifest).map((perm) => perm.type))
    const available = ALLOWED_PERMISSIONS.filter((perm) => !declared.has(perm))
    if (available.length === 0) {
      p.note("All permissions are already declared. Nothing to add.", "Permissions")
      p.outro("Done")
      return
    }
    const picked = await p.select({
      message: "Which permission?",
      options: available.map((perm) => ({value: perm, label: perm, hint: permissionDescription(perm)})),
    })
    if (p.isCancel(picked)) {
      p.cancel("Cancelled.")
      return
    }
    type = picked as string
    const desc = await p.text({
      message: "Optional description (shown to the user when the OS prompts for permission):",
      placeholder: "(skip)",
    })
    if (p.isCancel(desc)) {
      p.cancel("Cancelled.")
      return
    }
    if (typeof desc === "string" && desc.trim()) description = desc.trim()
  }

  let updated: Manifest
  try {
    updated = addPermission(manifest, type!, description !== undefined ? {description} : undefined)
  } catch (e) {
    if (e instanceof MutateError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }

  persistOrExit(path, updated)
  printPermissions(updated)
  if (typeArg === undefined) {
    p.outro("Saved miniapp.json ✨")
  }
}

export async function removePermissionCmd(typeArg?: string): Promise<void> {
  const {path, manifest} = loadOrExit()
  let type = typeArg

  if (!type) {
    const declared = listPermissions(manifest)
    if (declared.length === 0) {
      console.log("No permissions declared. Nothing to remove.")
      return
    }
    p.intro("Remove a permission")
    const picked = await p.select({
      message: "Which permission to remove?",
      options: declared.map((perm) => ({value: perm.type, label: perm.type})),
    })
    if (p.isCancel(picked)) {
      p.cancel("Cancelled.")
      return
    }
    type = picked as string
  }

  let updated: Manifest
  try {
    updated = removePermission(manifest, type!)
  } catch (e) {
    if (e instanceof MutateError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }

  persistOrExit(path, updated)
  printPermissions(updated)
}
