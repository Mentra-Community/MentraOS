import assert from "node:assert/strict"
import {existsSync, readFileSync} from "node:fs"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = path.join(packageRoot, "src")

function resolveRelativeImport(importer, specifier) {
  const candidate = path.resolve(path.dirname(importer), specifier)
  for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const resolved = `${candidate}${suffix}`
    if (existsSync(resolved)) return resolved
  }
  return null
}

function dependencyClosure(entry) {
  const pending = [entry]
  const visited = new Set()
  while (pending.length) {
    const file = pending.pop()
    if (!file || visited.has(file)) continue
    visited.add(file)
    const source = readFileSync(file, "utf8")
    const importPattern = /(?:from\s+|import\s*)["'](\.[^"']+)["']/g
    for (const match of source.matchAll(importPattern)) {
      const resolved = resolveRelativeImport(file, match[1])
      if (resolved) pending.push(resolved)
    }
  }
  return visited
}

test("public Engine OTA dependency closure uses supported Bluetooth SDK entrypoints", () => {
  const entry = path.join(sourceRoot, "react/index.ts")
  const closure = dependencyClosure(entry)
  const violations = []
  for (const file of closure) {
    const source = readFileSync(file, "utf8")
    if (source.includes("@mentra/bluetooth-sdk/internal")) {
      violations.push(path.relative(packageRoot, file))
    }
  }
  assert.deepEqual(violations, [])
})

test("stock OTA flow renders the same public controller available to customers", () => {
  const flow = readFileSync(path.join(sourceRoot, "react/MentraLiveOtaFlow.tsx"), "utf8")
  assert.match(flow, /useMentraLiveOta\(/)
  assert.doesNotMatch(flow, /ota\.installSession|ota\.checkForUpdates/)

  const index = readFileSync(path.join(sourceRoot, "react/index.ts"), "utf8")
  assert.match(index, /useMentraLiveOta/)
  assert.match(index, /MentraLiveOtaController/)
})
