import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

const podspec = readFileSync(new URL("../modules/acs-meeting/ios/AcsMeeting.podspec", import.meta.url), "utf8")
const script = podspec.match(/:script => %\(([\s\S]*?)\n      \),/)[1]
const header = "AzureCommunicationCommon-Swift.h"

function fixture(t) {
  // Spaces also exercise the quoting required by Xcode build directories.
  const root = mkdtempSync(path.join(tmpdir(), "acs ios headers "))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const build = path.join(root, "Release-iphoneos")
  const intermediates = path.join(root, "Selected XCFrameworks")
  const pods = path.join(root, "Pods")
  return {
    xc: path.join(intermediates, "AzureCommunicationCommon/AzureCommunicationCommon.framework/Headers", header),
    dynamic: path.join(build, "AzureCommunicationCommon/AzureCommunicationCommon.framework/Headers", header),
    static: path.join(build, "AzureCommunicationCommon/Swift Compatibility Header", header),
    public: path.join(pods, "Headers/Public/AzureCommunicationCommon", header),
    fake: path.join(build, "AcsMeeting/AzureCommunicationCommon.framework/Headers", header),
    run: () =>
      spawnSync("/bin/bash", ["-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PODS_CONFIGURATION_BUILD_DIR: build,
          PODS_XCFRAMEWORKS_BUILD_DIR: intermediates,
          PODS_ROOT: pods,
        },
      }),
  }
}

function writeHeader(file, contents) {
  mkdirSync(path.dirname(file), {recursive: true})
  writeFileSync(file, contents)
}

for (const mode of ["xc", "dynamic", "static"]) {
  test(`ACS exports the ${mode} Common header without replacing the real framework`, (t) => {
    const files = fixture(t)
    writeHeader(files[mode], `${mode} header`)
    const result = files.run()
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(readFileSync(files.public, "utf8"), `${mode} header`)
    assert.equal(readFileSync(files[mode], "utf8"), `${mode} header`)
    assert.equal(existsSync(files.fake), mode === "static")
    if (mode === "static") assert.equal(readFileSync(files.fake, "utf8"), "static header")

    const originalMtime = statSync(files.public).mtimeMs
    assert.equal(files.run().status, 0)
    assert.equal(statSync(files.public).mtimeMs, originalMtime, "unchanged headers should not trigger rebuilds")
    writeHeader(files[mode], "updated header")
    assert.equal(files.run().status, 0)
    assert.equal(readFileSync(files.public, "utf8"), "updated header")
  })
}

test("ACS prefers the selected XCFramework slice over stale source-build headers", (t) => {
  const files = fixture(t)
  writeHeader(files.xc, "selected platform header")
  writeHeader(files.dynamic, "old dynamic header")
  writeHeader(files.static, "old static header")
  const result = files.run()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(readFileSync(files.public, "utf8"), "selected platform header")
  assert.equal(existsSync(files.fake), false)
})

test("ACS fails with searched paths when no Common header is available", (t) => {
  const files = fixture(t)
  const result = files.run()
  assert.equal(result.status, 1)
  assert.ok(result.stdout.includes("AzureCommunicationCommon-Swift.h missing"))
  for (const mode of ["xc", "dynamic", "static"]) assert.ok(result.stdout.includes(files[mode]))
  assert.equal(existsSync(files.public), false)
  assert.equal(existsSync(files.fake), false)
})
