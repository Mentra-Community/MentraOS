import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const hash = (value) => createHash("sha256").update(value).digest("hex")
const sourcePaths = ["mobile", "android_core", "cloud-v2", "changelogs", "package.json", "bun.lock"]
const git = (args) => execFileSync("git", args, {encoding: "utf8"})

// Absolute paths are embedded in Xcode's build graph. Never restore that graph
// into a different workspace/toolchain/backend; changed source stays the native
// build system's responsibility, including newly generated release metadata.
export function cacheScope({workspace, xcode, node, bun, environment, dependencies}) {
  return hash(JSON.stringify({schema: 2, workspace, xcode, node, bun, environment, dependencies}))
}

export function nativeSources(root, files) {
  const result = new Set(files)
  // Dependencies and generated native files are not in Git. Their contents,
  // not installation/checkout timestamps, decide whether cached work is valid.
  const walk = (directory) => {
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(file)
      // CocoaPods -include's its generated prefix.pch in every translation
      // unit. Leaving those mtimes fresh invalidates otherwise unchanged Pods.
      else if (entry.isFile() && /\.(?:h|hpp|hxx|pch|inc|inl|ipp|c|cc|cpp|m|mm|swift|modulemap)$/.test(entry.name)) result.add(path.relative(root, file))
    }
  }
  for (const directory of ["node_modules", "mobile/node_modules", "mobile/ios/Pods", "mobile/ios/build/generated"]) walk(path.join(root, directory))
  return [...result]
}

export function snapshotSources(root, files) {
  return Object.fromEntries(files.flatMap((name) => {
    const file = path.join(root, name)
    if (!existsSync(file)) return []
    const stat = lstatSync(file, {bigint: true})
    if (!stat.isFile()) return []
    return [[name, {sha256: hash(readFileSync(file)), mtimeNs: stat.mtimeNs.toString()}]]
  }))
}

export function restoreSourceTimes(root, currentFiles, previous) {
  const updates = []
  // Iterate the current Git inventory, never paths supplied by a cache entry.
  for (const name of currentFiles) {
    const record = previous[name]
    if (!record || !/^\d+$/.test(record.mtimeNs ?? "")) continue
    const file = path.join(root, name)
    if (!existsSync(file)) continue
    const stat = lstatSync(file, {bigint: true})
    if (!stat.isFile() || hash(readFileSync(file)) !== record.sha256) continue
    updates.push([file, stat.atimeNs.toString(), record.mtimeNs])
  }
  // Node's Date/utimes path rounds timestamps. Xcode records sub-millisecond
  // mtimes, so restore exact nanoseconds through the host's Python stdlib.
  if (updates.length) execFileSync("python3", ["-c",
    "import json, os, sys\nfor file, access, modified in json.load(sys.stdin): os.utime(file, ns=(int(access), int(modified)))"],
    {input: JSON.stringify(updates)})
  return updates.length
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  const root = git(["rev-parse", "--show-toplevel"]).trim()
  if (mode === "key") {
    const dependencies = git(["ls-tree", "-r", "HEAD", "--", "mobile/bun.lock", "bun.lock", "mobile/Gemfile.lock", "mobile/package.json", "mobile/ios/Podfile.lock", "mobile/scripts/native-build-cache.mjs"])
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      key.startsWith("EXPO_PUBLIC_") && !/^EXPO_PUBLIC_(BUILD_(COMMIT|BRANCH|TIME|USER)|MENTRAOS_VERSION|ASG_OTA_VERSION_URL)$/.test(key),
    ).sort(([a], [b]) => a.localeCompare(b)))
    const scope = cacheScope({workspace: root, xcode: JSON.stringify([process.arch, execFileSync("xcodebuild", ["-version"], {encoding: "utf8"}), execFileSync("xcrun", ["--sdk", "iphoneos", "--show-sdk-build-version"], {encoding: "utf8"})]),
      node: process.version, bun: execFileSync("bun", ["--version"], {encoding: "utf8"}), environment, dependencies})
    const source = hash(git(["ls-tree", "-r", "HEAD", "--", ...sourcePaths]))
    appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\nsource=${source}\n`)
  } else {
    const file = path.resolve(process.argv[3])
    const files = nativeSources(root, git(["ls-files", "-z", "--", ...sourcePaths]).split("\0").filter(Boolean))
    if (mode === "save") writeFileSync(file, JSON.stringify(snapshotSources(root, files)))
    else if (mode === "restore") {
      if (existsSync(file)) console.log(`Restored timestamps for ${restoreSourceTimes(root, files, JSON.parse(readFileSync(file, "utf8")))} unchanged sources`)
    } else throw new Error("Expected key, save or restore")
  }
}
