import assert from "node:assert/strict"
import {chmodSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {spawnSync} from "node:child_process"
import test from "node:test"
import {fileURLToPath} from "node:url"

const script = fileURLToPath(new URL("./ios-ccache-wrappers.sh", import.meta.url))

const run = (env, args = []) =>
  spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {...process.env, ...env},
  })

const cacheEnv = (dir) => ({
  CCACHE_DIR: join(dir, "cache"),
  CCACHE_CONFIGPATH: join(dir, "ccache.conf"),
  CCACHE_BASEDIR: join(dir, "base"),
  CCACHE_STATSLOG: join(dir, "stats.log"),
})

test("writes executable wrappers that exec the given ccache binary", () => {
  const dir = mkdtempSync(join(tmpdir(), "ios-ccache-wrappers-"))
  const ccache = join(dir, "ccache")
  writeFileSync(ccache, "#!/bin/sh\necho fake-ccache\n")
  chmodSync(ccache, 0o755)
  const out = join(dir, "wrappers")

  const result = run({...cacheEnv(dir), PATH: "/usr/bin:/bin"}, [ccache, out])
  assert.equal(result.status, 0, result.stderr)
  const [clangSh, clangppSh] = result.stdout.trim().split("\n")
  assert.equal(clangSh, join(out, "mentra-ccache-clang.sh"))
  assert.equal(clangppSh, join(out, "mentra-ccache-clang++.sh"))

  const clang = readFileSync(clangSh, "utf8")
  const clangpp = readFileSync(clangppSh, "utf8")
  assert.match(clang, /exec '.*\/ccache' clang "\$@"/)
  assert.match(clangpp, /exec '.*\/ccache' clang\+\+ "\$@"/)
  assert.match(clang, new RegExp(`export CCACHE_DIR='${join(dir, "cache")}'`))
  assert.match(clang, new RegExp(`export CCACHE_STATSLOG='${join(dir, "stats.log")}'`))
  assert.match(clang, /export CCACHE_NOHASHDIR=1/)
  assert.doesNotMatch(clang, /CCACHE_BINARY/)

  const invoked = spawnSync("sh", [clangSh, "-c", "noop"], {encoding: "utf8"})
  assert.equal(invoked.status, 0, invoked.stderr)
  assert.match(invoked.stdout, /fake-ccache/)
})

test("rejects a missing ccache binary", () => {
  const dir = mkdtempSync(join(tmpdir(), "ios-ccache-wrappers-"))
  const result = run(
    {...cacheEnv(dir), PATH: "/usr/bin:/bin", CCACHE_BINARY: ""},
    [join(dir, "missing"), dir],
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ccache binary not found/)
})

test("rejects a path that would break the generated shell", () => {
  const dir = mkdtempSync(join(tmpdir(), "ios-ccache-wrappers-"))
  const ccache = join(dir, "ccache")
  writeFileSync(ccache, "#!/bin/sh\n")
  chmodSync(ccache, 0o755)
  const result = run({
    ...cacheEnv(dir),
    CCACHE_DIR: join(dir, "cache") + "'oops",
    PATH: "/usr/bin:/bin",
  }, [ccache, dir])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unsafe path/)
})
