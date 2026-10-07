import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {appendFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {MOBILE_SOURCE_PATHS} from "../../.github/scripts/mobile-build-inputs.mjs"

const hash = (value) => createHash("sha256").update(value).digest("hex")
const git = (args) => execFileSync("git", args, {encoding: "utf8"})

export function cacheSource({cwd = process.cwd(), ref = "HEAD"} = {}) {
  return hash(execFileSync("git", ["ls-tree", "-r", ref, "--", ...MOBILE_SOURCE_PATHS], {cwd, encoding: "utf8"}))
}

// Isolate Xcode's content-addressed compiler cache by workspace, tools and
// runtime environment. The compiler validates the source inputs; no checkout
// timestamps or build graph are restored.
export function cacheScope({workspace, xcode, node, bun, environment}) {
  return hash(JSON.stringify({schema: 3, workspace, xcode, node, bun, environment}))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  const root = git(["rev-parse", "--show-toplevel"]).trim()
  if (mode === "key") {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      key.startsWith("EXPO_PUBLIC_") && !/^EXPO_PUBLIC_(BUILD_(COMMIT|BRANCH|TIME|USER)|MENTRAOS_VERSION|ASG_OTA_VERSION_URL)$/.test(key),
    ).sort(([a], [b]) => a.localeCompare(b)))
    const scope = cacheScope({workspace: root, xcode: JSON.stringify([process.arch, execFileSync("xcodebuild", ["-version"], {encoding: "utf8"}), execFileSync("xcrun", ["--sdk", "iphoneos", "--show-sdk-build-version"], {encoding: "utf8"})]),
      node: process.version, bun: execFileSync("bun", ["--version"], {encoding: "utf8"}), environment})
    const source = cacheSource({cwd: root})
    appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\nsource=${source}\n`)
  } else throw new Error("Expected key")
}
