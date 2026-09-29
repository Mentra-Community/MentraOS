import {expect, test} from "bun:test"
import {resolve} from "node:path"

test("starting public Cloud V2 leaves a separately running Store alone", () => {
  // Stub process control and stop before setup; no real listener is killed.
  const result = Bun.spawnSync(["bash", "-c", String.raw`
    lsof() {
      case "$*" in
        *-tiTCP:3000*) echo 111111 ;;
        *-tiTCP:3003*) echo 333333 ;;
      esac
    }
    kill() { printf 'stopped:%s\n' "$*"; }
    bun() { return 1; }
    source scripts/dev-local.sh
  `], {cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe"})
  const output = new TextDecoder().decode(result.stdout)
  expect(new TextDecoder().decode(result.stderr)).toBe("")
  expect(result.exitCode).toBe(1)
  expect(output).toContain("stopped:111111")
  expect(output).not.toContain("stopped:333333")
})
