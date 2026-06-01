// File I/O for miniapp.json. Atomic writes, line/column-precise parse errors.

import {existsSync, readFileSync, renameSync, writeFileSync, unlinkSync} from "fs"
import {resolve} from "path"
import type {Manifest} from "./manifest-mutate.js"

export type ManifestLoadError =
  | {code: "not_found"; path: string}
  | {code: "parse_error"; path: string; line: number; column: number; message: string}
  | {code: "not_object"; path: string}

export type ManifestWriteError = {code: "write_failed"; path: string; cause: string}

export interface LoadedManifest {
  path: string
  raw: string
  manifest: Manifest
}

/**
 * Load `miniapp.json` from `cwd`. Returns either the parsed manifest or a
 * structured error describing what went wrong, including line/column for
 * parse errors so the CLI can show the developer where to look.
 */
export function loadManifest(cwd: string): {ok: true; value: LoadedManifest} | {ok: false; error: ManifestLoadError} {
  const path = resolve(cwd, "miniapp.json")
  if (!existsSync(path)) {
    return {ok: false, error: {code: "not_found", path}}
  }
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (e) {
    return {ok: false, error: {code: "parse_error", path, line: 0, column: 0, message: String(e)}}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    const {line, column} = locateJsonParseError(raw, e as Error)
    return {ok: false, error: {code: "parse_error", path, line, column, message: (e as Error).message}}
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {ok: false, error: {code: "not_object", path}}
  }

  return {ok: true, value: {path, raw, manifest: parsed as Manifest}}
}

/**
 * Atomic write of `miniapp.json`. Writes to `<path>.tmp`, then renames in
 * place. 2-space indentation matches the rest of the codebase. Pure JSON
 * (no comments preserved — miniapp.json isn't JSONC).
 */
export function writeManifest(path: string, manifest: Manifest): {ok: true} | {ok: false; error: ManifestWriteError} {
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8")
    renameSync(tmp, path)
    return {ok: true}
  } catch (e) {
    try {
      // Best-effort cleanup of the partial tmp file.
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    return {ok: false, error: {code: "write_failed", path, cause: String(e)}}
  }
}

/**
 * Bun and V8 surface JSON parse errors with messages like
 *   "JSON Parse error: Unexpected token at line 4, column 12"
 *   "Unexpected token } in JSON at position 87"
 * We extract the position and convert to (line, column) for friendlier output.
 */
function locateJsonParseError(raw: string, err: Error): {line: number; column: number} {
  const msg = err.message
  // Try Bun's "at line X, column Y" first (already 1-indexed).
  const directMatch = msg.match(/at line (\d+), column (\d+)/i)
  if (directMatch) {
    return {line: parseInt(directMatch[1], 10), column: parseInt(directMatch[2], 10)}
  }
  // Fallback: V8-style "at position N".
  const posMatch = msg.match(/position (\d+)/i)
  if (posMatch) {
    const pos = parseInt(posMatch[1], 10)
    let line = 1
    let column = 1
    for (let i = 0; i < pos && i < raw.length; i++) {
      if (raw[i] === "\n") {
        line++
        column = 1
      } else {
        column++
      }
    }
    return {line, column}
  }
  return {line: 0, column: 0}
}

export function formatLoadError(error: ManifestLoadError): string {
  switch (error.code) {
    case "not_found":
      return `No miniapp.json found in this directory.\n  Expected: ${error.path}`
    case "parse_error": {
      const loc = error.line > 0 ? ` at line ${error.line}, column ${error.column}` : ""
      return `miniapp.json is not valid JSON${loc}.\n  ${error.path}\n  ${error.message}`
    }
    case "not_object":
      return `miniapp.json must be a JSON object (got an array or primitive).\n  ${error.path}`
  }
}

export function formatWriteError(error: ManifestWriteError): string {
  return `Failed to write miniapp.json:\n  ${error.path}\n  ${error.cause}`
}
