import {test} from "node:test"
import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"

import {cacheScope, cacheSource} from "./native-build-cache.mjs"

test("native cache scope isolates workspace, tools and runtime environment", () => {
  const base = {workspace: "/build/repo", xcode: "26.2", node: "20", bun: "1.4", environment: {backend: "dev"}}
  for (const key of Object.keys(base)) assert.notEqual(cacheScope(base), cacheScope({...base, [key]: "changed"}))
  assert.equal(cacheScope(base), cacheScope({...base}))
})

test("coordinated compiler cache ignores backend changes and tracks every app source dependency", (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "coordinated-native-cache-"))
  t.after(() => rmSync(cwd, {recursive: true, force: true}))
  const git = (...args) => execFileSync("git", args, {cwd, encoding: "utf8"})
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(cwd, file)), {recursive: true})
    writeFileSync(path.join(cwd, file), content)
  }
  const commit = () => {
    git("add", ".")
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture change")
  }
  const appInputs = [
    "mobile/src/App.tsx",
    "mobile/bun.lock",
    "cloud-v2/bun.lock",
    "mobile/modules/bluetooth-sdk/ios/Source/GeneratedChangelogCatalog.swift",
    "mobile/modules/engine/src/index.ts",
    "android_core/src/main/java/App.java",
    "cloud-v2/packages/cloud-client/src/index.ts",
    "cloud-v2/packages/cloud-client/react-native/index.ts",
    "cloud-v2/packages/cloud-client/package.json",
    "cloud-v2/packages/protocol/src/index.ts",
    "cloud-v2/packages/protocol/package.json",
    "cloud-v2/packages/runtime/src/protocol/index.ts",
    "package.json",
    "bun.lock",
  ]
  const backendInputs = [
    "cloud-v2/websites/admin/src/components/TestHistoryTable.tsx",
    "cloud-v2/websites/console/src/App.tsx",
    "cloud-v2/services/core/src/index.ts",
    "cloud-v2/packages/runtime/src/server.ts",
    "cloud-v2/packages/cloud-client/node/index.ts",
    "asg_client/src/main/java/App.java",
    "changelogs/3.1.0.md",
  ]
  git("init", "-q")
  for (const file of appInputs) write(file, "original")
  commit()
  const originalSource = cacheSource({cwd})
  for (const file of backendInputs) write(file, "backend change")
  commit()
  assert.equal(cacheSource({cwd}), originalSource)
  for (const file of appInputs) {
    const previousSource = cacheSource({cwd})
    write(file, "app input change")
    commit()
    assert.notEqual(cacheSource({cwd}), previousSource, file)
  }
  const previousSource = cacheSource({cwd})
  rmSync(path.join(cwd, appInputs[0]))
  commit()
  assert.notEqual(cacheSource({cwd}), previousSource, "deleted app source")
})
