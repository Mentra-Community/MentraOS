#!/usr/bin/env node
import {readFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    values[option.slice(2)] = value
  }
  return values
}

function mentraNameFromLockPath(lockPath) {
  const match = lockPath.match(/(?:^|\/)node_modules\/(@mentra\/[^/]+)$/)
  return match?.[1] ?? null
}

function engineClosure(plan) {
  const expected = new Set()
  function visit(name) {
    if (expected.has(name)) return
    const member = plan.members?.[name]
    if (!member) throw new Error(`Release plan is missing ${name}`)
    expected.add(name)
    for (const dependency of member.dependencies ?? []) visit(dependency)
  }
  visit("@mentra/engine")
  return expected
}

export function verifyExternalEngineInstall({fixtureDir, plan}) {
  const packageJson = JSON.parse(readFileSync(path.join(fixtureDir, "package.json"), "utf8"))
  const directMentra = Object.entries(packageJson.dependencies ?? {}).filter(([name]) => name.startsWith("@mentra/"))
  if (directMentra.length !== 1 || directMentra[0][0] !== "@mentra/engine") {
    throw new Error("External fixture must directly install only @mentra/engine")
  }
  if (directMentra[0][1] !== plan.releaseIdentity) {
    throw new Error(`External fixture Engine version is ${directMentra[0][1]}, expected ${plan.releaseIdentity}`)
  }

  const packageLock = JSON.parse(readFileSync(path.join(fixtureDir, "package-lock.json"), "utf8"))
  const expected = engineClosure(plan)
  const installed = new Map()
  for (const [lockPath, entry] of Object.entries(packageLock.packages ?? {})) {
    const name = mentraNameFromLockPath(lockPath)
    if (!name) continue
    const records = installed.get(name) ?? []
    records.push({lockPath, ...entry})
    installed.set(name, records)
  }

  for (const name of expected) {
    const records = installed.get(name) ?? []
    if (records.length !== 1) throw new Error(`${name} resolved ${records.length} physical copies; expected exactly one`)
    const [record] = records
    if (record.version !== plan.releaseIdentity) {
      throw new Error(`${name} resolved ${record.version}, expected ${plan.releaseIdentity}`)
    }
    if (record.link || !record.resolved?.startsWith("https://registry.npmjs.org/") || !record.integrity?.startsWith("sha512-")) {
      throw new Error(`${name} did not resolve as an integrity-checked public npm artifact`)
    }
  }

  const unexpected = [...installed.keys()].filter((name) => !expected.has(name))
  if (unexpected.length) throw new Error(`Unexpected Mentra packages in external fixture: ${unexpected.join(", ")}`)
  return [...expected].sort()
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.fixture || !args.plan) throw new Error("Missing --fixture or --plan")
  const plan = JSON.parse(readFileSync(path.resolve(args.plan), "utf8"))
  const packages = verifyExternalEngineInstall({fixtureDir: path.resolve(args.fixture), plan})
  console.log(`Verified public Engine closure: ${packages.join(", ")}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
