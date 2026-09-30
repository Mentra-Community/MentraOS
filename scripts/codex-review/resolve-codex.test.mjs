import {afterEach, expect, test} from "bun:test"
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {resolveCodex} from "./resolve-codex.mjs"

const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-cli-"))
  roots.push(root)
  return {root, env: {PATH: join(root, "bin"), HOME: root}, platform: "linux"}
}
function cli(path, body = "printf '%s\\n' '--json --stdio'") {
  mkdirSync(join(path, ".."), {recursive: true})
  writeFileSync(path, `#!/bin/sh\n${body}\n`, {mode: 0o755})
  return path
}

test("uses a working PATH CLI for both review transports", () => {
  const f = fixture()
  const path = cli(join(f.env.PATH, "codex"))
  expect(resolveCodex("exec", f)).toBe(path)
  expect(resolveCodex("app-server", f)).toBe(path)
})

test("skips a broken executable shim and finds the next PATH CLI", () => {
  const f = fixture()
  cli(join(f.env.PATH, "codex"), "exec /missing/codex-native-binary \"$@\"")
  const working = cli(join(f.root, "second path", "codex"))
  f.env.PATH += `:${join(f.root, "second path")}`
  expect(resolveCodex("app-server", f)).toBe(working)
})

test("discovers the bundled macOS CLI when PATH is broken", () => {
  const f = fixture()
  cli(join(f.env.PATH, "codex"), "exec /missing/codex-native-binary \"$@\"")
  const working = cli(join(f.root, "Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"))
  expect(resolveCodex("app-server", {...f, platform: "darwin"})).toBe(working)
})

test("honors an explicit install and refuses an invalid override", () => {
  const f = fixture()
  cli(join(f.env.PATH, "codex"))
  const selected = cli(join(f.root, "selected codex"))
  expect(resolveCodex("exec", {...f, env: {...f.env, CODEX_BIN: selected}})).toBe(selected)
  expect(() => resolveCodex("exec", {...f, env: {...f.env, CODEX_BIN: join(f.root, "missing")}})).toThrow("unset CODEX_BIN")
})

test("rejects a CLI missing the requested transport instead of starting a review", () => {
  const f = fixture()
  cli(join(f.env.PATH, "codex"), "echo '--json'")
  expect(() => resolveCodex("app-server", f)).toThrow("No working Codex CLI")
  expect(resolveCodex("exec", f)).toBe(join(f.env.PATH, "codex"))
})
