import assert from "node:assert/strict"
import {chmodSync, mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {spawnSync} from "node:child_process"
import test from "node:test"
import {fileURLToPath} from "node:url"

const script = fileURLToPath(new URL("./ios-ensure-ccache.sh", import.meta.url))

const run = (env) =>
  spawnSync("bash", [script], {
    encoding: "utf8",
    env: {...process.env, ...env},
  })

test("returns an existing ccache on PATH without calling brew", () => {
  const dir = mkdtempSync(join(tmpdir(), "ios-ensure-ccache-"))
  const fake = join(dir, "ccache")
  writeFileSync(fake, "#!/bin/sh\necho fake\n")
  chmodSync(fake, 0o755)
  const brew = join(dir, "brew")
  writeFileSync(brew, "#!/bin/sh\necho brew-should-not-run >&2; exit 9\n")
  chmodSync(brew, 0o755)

  const result = run({
    PATH: `${dir}:/usr/bin:/bin`,
    MENTRA_IOS_CCACHE_BREW: brew,
    MENTRA_IOS_CCACHE_LOCK_DIR: join(dir, "lock"),
    MENTRA_IOS_CCACHE_CANDIDATES: join(dir, "missing-ccache"),
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), fake)
  assert.doesNotMatch(result.stderr, /brew-should-not-run/)
})

test("exits 1 when missing and auto-install is disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "ios-ensure-ccache-"))
  const result = run({
    PATH: "/usr/bin:/bin",
    MENTRA_IOS_CCACHE_AUTO_INSTALL: "0",
    MENTRA_IOS_CCACHE_LOCK_DIR: join(dir, "lock"),
    MENTRA_IOS_CCACHE_CANDIDATES: join(dir, "ccache"),
    MENTRA_IOS_CCACHE_BREW: join(dir, "brew"),
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /MENTRA_IOS_CCACHE_AUTO_INSTALL=0/)
})

test("installs via the injected brew helper and then prints the new path", () => {
  const dir = mkdtempSync(join(tmpdir(), "ios-ensure-ccache-"))
  const candidate = join(dir, "prefix", "ccache")
  const brew = join(dir, "brew")
  writeFileSync(
    brew,
    `#!/bin/sh
set -e
if [ "$1" != "install" ] || [ "$2" != "ccache" ]; then
  echo "unexpected brew args: $*" >&2
  exit 8
fi
mkdir -p "$(dirname "${candidate}")"
printf '#!/bin/sh\\necho fake-ccache\\n' > "${candidate}"
chmod +x "${candidate}"
`,
  )
  chmodSync(brew, 0o755)

  const result = run({
    PATH: "/usr/bin:/bin",
    MENTRA_IOS_CCACHE_BREW: brew,
    MENTRA_IOS_CCACHE_LOCK_DIR: join(dir, "lock"),
    MENTRA_IOS_CCACHE_CANDIDATES: candidate,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), candidate)
  assert.match(result.stderr, /installing via Homebrew/)
})
