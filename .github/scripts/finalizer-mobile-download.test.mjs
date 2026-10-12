import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"

const workflow = readFileSync(new URL("../workflows/coordinated-release.yml", import.meta.url), "utf8")
const step = workflow.split("      - name: Download and validate complete mobile publication evidence\n")[1]
  ?.split("\n      - name:")[0]
assert.ok(step, "The finalizer must use the checked mobile download step")
const script = step.split("        run: |\n")[1].replace(/^          /gm, "")

test("checked download retains exact artifact binding and the finalized-result restore guard", () => {
  assert.match(step, /if: steps\.restore-result\.outputs\.restored != 'true'/)
  assert.match(step, /GH_TOKEN: \$\{\{ github.token \}\}/)
  assert.match(step, /MOBILE_ARTIFACT: \$\{\{ needs.mobile.outputs.result_artifact \}\}/)
  assert.match(step, /RELEASE_SET_ID: \$\{\{ needs.plan.outputs.release_set_id \}\}/)
  assert.doesNotMatch(step, /continue-on-error|\|\| true/)
})

for (const mode of ["success", "partial-error", "missing", "empty", "malformed", "wrong-release", "existing"]) {
  test(`mobile evidence download: ${mode}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "finalizer-mobile-download-"))
    try {
      mkdirSync(join(directory, "bin"))
      mkdirSync(join(directory, "release-input"))
      const destination = join(directory, "release-input/mobile")
      if (mode === "existing") {
        mkdirSync(destination)
        writeFileSync(join(destination, "original"), "preserve")
      }
      // Simulate the CLI's filesystem and exit-status boundary, including a
      // valid receipt written before a later archive entry fails extraction.
      writeFileSync(join(directory, "bin/gh"), `#!${process.execPath}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 7), ["run", "download", "123", "--repo", "owner/repo", "--name", "coordinated-mobile-test"]);
assert.equal(args[7], "--dir");
const destination = args[8];
fs.writeFileSync("gh-called", "yes");
fs.writeFileSync(path.join(destination, "partial.apk"), "bytes");
const mode = process.env.DOWNLOAD_TEST_MODE;
if (mode !== "missing") {
  const contents = mode === "empty" ? "" : mode === "malformed" ? "{" : JSON.stringify({releaseSetId: mode === "wrong-release" ? "other" : "mentra-test"});
  fs.writeFileSync(path.join(destination, "mobile-publications.json"), contents);
}
if (mode === "partial-error") {
  process.stderr.write("original extraction failure\\n");
  process.exit(23);
}
`, {mode: 0o755})
      const result = spawnSync("bash", ["-c", script], {
        cwd: directory,
        encoding: "utf8",
        env: {...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`,
          GITHUB_RUN_ID: "123", GITHUB_REPOSITORY: "owner/repo", MOBILE_ARTIFACT: "coordinated-mobile-test",
          RELEASE_SET_ID: "mentra-test", DOWNLOAD_TEST_MODE: mode},
      })
      if (mode === "success") {
        assert.equal(result.status, 0, result.stderr)
        assert.equal(JSON.parse(readFileSync(join(destination, "mobile-publications.json"))).releaseSetId, "mentra-test")
      } else {
        assert.notEqual(result.status, 0)
        if (mode === "existing") {
          assert.equal(readFileSync(join(destination, "original"), "utf8"), "preserve")
          assert.equal(existsSync(join(directory, "gh-called")), false)
        } else {
          assert.equal(existsSync(destination), false, "Assembly must not see partial evidence")
        }
        if (mode === "partial-error") {
          assert.equal(result.status, 23, "Preserve the download/extraction exit status")
          assert.match(result.stderr, /original extraction failure/)
        }
      }
      assert.deepEqual(readdirSync(join(directory, "release-input")), mode === "success" || mode === "existing" ? ["mobile"] : [])
    } finally {
      rmSync(directory, {recursive: true, force: true})
    }
  })
}
