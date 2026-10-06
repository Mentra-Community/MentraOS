import {existsSync, lstatSync, readFileSync, readdirSync, realpathSync} from "node:fs"
import {dirname, join, resolve} from "node:path"

// External package storage may be shared. Workspace source and incompatible
// dependency resolutions must stay outside this exact-head review.
const [review, anchor] = process.argv.slice(2)
const names = ["node_modules", "tools/mentra-e2e/node_modules"]
const sources = names.map((name) => join(anchor, name)).filter(existsSync)
const roots = sources.map((source) => realpathSync(source))
const inside = (path) => roots.some((root) => path === root || path.startsWith(`${root}/`))
const fail = (message) => {throw new Error(message)}
const locks = ["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]
const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
const dependencySet = (directory) => {
  const path = join(directory, "package.json")
  if (!existsSync(path)) return null
  const value = JSON.parse(readFileSync(path, "utf8")), output = {}
  for (const field of fields) {
    output[field] = Object.fromEntries(Object.entries(value[field] ?? {}).sort(([a], [b]) => a.localeCompare(b)))
    if (Object.values(output[field]).some((version) => typeof version !== "string" || /^(workspace:|file:|link:|\.\.?\/|\/)/.test(version))) {
      fail("local or workspace dependency cannot use shared review storage")
    }
  }
  return JSON.stringify(output)
}

try {
  if (!review || !anchor || roots.length === 0) fail("missing review dependency paths")
  for (const root of roots) {
    const walk = (directory) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry), stat = lstatSync(path)
        if (stat.isSymbolicLink()) {
          if (!inside(realpathSync(path))) fail(`dependency link escapes external package storage: ${path.slice(root.length + 1)}`)
        } else if (stat.isDirectory()) walk(path)
      }
    }
    walk(root)
  }
  for (const name of names) {
    const source = join(anchor, name)
    if (!existsSync(source)) continue
    const root = realpathSync(source), selected = dirname(join(resolve(review), name)), storage = dirname(root)
    if (!existsSync(selected)) continue
    if (name === "tools/mentra-e2e/node_modules" && !existsSync(join(selected, "package.json"))) continue
    if (dependencySet(selected) !== dependencySet(storage)) fail(`dependency declarations differ for ${name}`)
    for (const lock of locks) {
      const a = join(selected, lock), b = join(storage, lock)
      if (existsSync(a) !== existsSync(b) || (existsSync(a) && !readFileSync(a).equals(readFileSync(b)))) {
        fail(`dependency lock differs for ${name}/${lock}`)
      }
    }
  }
} catch (error) {
  console.error(`review dependency validation failed: ${error.message}`)
  process.exitCode = 1
}
