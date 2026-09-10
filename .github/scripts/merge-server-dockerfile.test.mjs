import assert from "node:assert/strict"
import {existsSync, readFileSync, readdirSync, statSync} from "node:fs"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {CLOUD_V2_TARGETS} from "./coordinated-cloud-v2-records.mjs"

// The Local Merge server image is built by Porter from the repository root and
// must copy every workspace manifest before `bun install`, or the coordinated
// Cloud V2 job fails at deploy time instead of in this PR check. The COPY list
// went stale twice in 2026 (removed miniapps, a new cloud-v2 package), so the
// list is verified against the root workspaces here.

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const dockerfilePath = "miniapps/merge/docker/Dockerfile"

function read(relative) {
  return readFileSync(path.join(rootDir, relative), "utf8")
}

function workspaceManifests() {
  const workspaces = JSON.parse(read("package.json")).workspaces
  assert.ok(Array.isArray(workspaces) && workspaces.length > 0, "root package.json must declare workspaces")
  const manifests = []
  for (const pattern of workspaces) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2)
      for (const entry of readdirSync(path.join(rootDir, parent)).sort()) {
        const manifest = path.posix.join(parent, entry, "package.json")
        if (existsSync(path.join(rootDir, manifest)) && statSync(path.join(rootDir, parent, entry)).isDirectory()) {
          manifests.push(manifest)
        }
      }
    } else {
      assert.ok(!pattern.includes("*"), `unsupported workspace pattern ${pattern}`)
      manifests.push(path.posix.join(pattern, "package.json"))
    }
  }
  return manifests
}

test("Merge server Dockerfile copies exactly the current workspace manifests before bun install", () => {
  const dockerfile = read(dockerfilePath)
  const installIndex = dockerfile.indexOf("RUN bun install")
  assert.notEqual(installIndex, -1, "Dockerfile must run bun install")
  const beforeInstall = dockerfile.slice(0, installIndex)
  const copied = [...beforeInstall.matchAll(/^COPY (\S+package\.json) (\S+)$/gm)].map(([, source, target]) => {
    assert.equal(target, `./${source}`, `${source} must be copied to its workspace path`)
    return source
  })
  const expected = workspaceManifests()
  assert.deepEqual(
    copied.filter((source) => source !== "package.json").sort(),
    expected.sort(),
    "Dockerfile workspace manifest COPY lines must match the root workspaces",
  )
  for (const source of copied) {
    assert.ok(existsSync(path.join(rootDir, source)), `${source} copied by the Dockerfile does not exist`)
  }
  assert.match(beforeInstall, /^COPY bun\.lock package\.json \.\/$/m)
})

test("every companion Porter config builds the Merge server image from the repository root", () => {
  for (const [environment, target] of Object.entries(CLOUD_V2_TARGETS)) {
    const companion = target.companions.merge
    assert.ok(companion, `${environment} must declare the merge companion app`)
    assert.ok(existsSync(path.join(rootDir, companion.porterConfig)), `${companion.porterConfig} must exist`)
    const config = read(companion.porterConfig)
    assert.match(config, /^version: v2$/m)
    assert.match(config, new RegExp(`^name: ${companion.porterApp}$`, "m"))
    assert.match(config, /^  context: \.\/$/m)
    assert.match(config, new RegExp(`^  dockerfile: \\./${dockerfilePath.replaceAll(".", "\\.")}$`, "m"))
    for (const hosts of Object.values(companion.services)) {
      for (const host of hosts) {
        assert.match(config, new RegExp(`^      - name: ${host.replaceAll(".", "\\.")}$`, "m"))
      }
    }
    assert.match(config, /^      httpPath: \/healthz$/m)
  }
})
