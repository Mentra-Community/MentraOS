import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

const action = readFileSync(new URL("../actions/disk-guard/action.yml", import.meta.url), "utf8")
const workflow = readFileSync(new URL("../workflows/mentra-app-ios-build.yml", import.meta.url), "utf8")

for (const free of [50, 30, 15]) {
  test(`disk guard at ${free} GiB applies the existing cleanup tier to isolated Pods caches`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ios-cache-cleanup-"))
    t.after(() => rmSync(root, {recursive: true, force: true}))
    mkdirSync(path.join(root, "bin"))
    const fake = (name, source) => writeFileSync(path.join(root, "bin", name), source, {mode: 0o755})
    fake("df", `#!/bin/sh\nprintf 'Filesystem 1G-blocks Used Available\nfixture 100 50 ${free}\n'\n`)
    fake("pkill", "#!/bin/sh\nexit 0\n")
    fake("gradle", "#!/bin/sh\nexit 0\n")
    const env = {...process.env, PATH: `${root}/bin:${process.env.PATH}`, CACHE_FIXTURE_ROOT: root,
      LIGHT_GB: "40", DEEP_GB: "20", KEEP_NDK: "27.1.12297006"}
    const cacheFor = (runner) => {
      const assignment = workflow.match(/^          cache_dir=.*$/m)[0].trim().replaceAll("$HOME", "$CACHE_FIXTURE_ROOT")
      const result = spawnSync("bash", ["-c", `${assignment}\nprintf '%s' "$cache_dir"`],
        {env: {...env, RUNNER_NAME: runner}, encoding: "utf8"})
      assert.equal(result.status, 0, result.stderr)
      assert.ok(result.stdout.startsWith(`${root}/`))
      return result.stdout
    }
    const caches = [cacheFor("runner-1"), cacheFor("runner-2"), path.join(root, "Library/Caches/CocoaPods")]
    assert.equal(new Set(caches).size, 3)
    for (const cache of caches) {
      mkdirSync(cache, {recursive: true})
      writeFileSync(path.join(cache, "archive"), "download")
    }
    // A normal per-runner pod recovery must leave the other runners intact.
    rmSync(path.join(caches[0], "archive"))
    assert.ok(existsSync(path.join(caches[1], "archive")))
    assert.ok(existsSync(path.join(caches[2], "archive")))
    writeFileSync(path.join(caches[0], "archive"), "download")
    // Run the real cleanup program, with every home-relative path relocated
    // into the fixture and process-control commands stubbed. Never touch the host.
    const script = action.split("      run: |\n")[1].replace(/^        /gm, "")
      .replaceAll("~/", '"$CACHE_FIXTURE_ROOT"/')
    assert.doesNotMatch(script, /~\//)
    const result = spawnSync("bash", ["-c", script], {env, encoding: "utf8", timeout: 10_000})
    assert.equal(result.status, 0, result.stderr)
    for (const cache of caches) assert.equal(existsSync(path.join(cache, "archive")), free >= 20)
  })
}
