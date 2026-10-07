import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

const source = readFileSync(new URL("./azure-readiness-diagnostics.sh", import.meta.url), "utf8")
const functions = source.split('if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then')[0]

test("startup classification emits only known codes, operations and migration names", () => {
  const root = mkdtempSync(path.join(tmpdir(), "azure-codes-"))
  try {
    const file = path.join(root, "console.json")
    writeFileSync(file, JSON.stringify({Log: 'private-token-must-not-print MongoServerError code: 67 codeName: CannotCreateIndex\nat createIndexes\nat runStartupMigrations'}))
    const result = spawnSync("bash", ["-c", `${functions}\nstartup_failure_codes "$SAMPLE"`], {
      env: {...process.env, SAMPLE: file}, encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /mongo-code-67/)
    assert.match(result.stderr, /mongo-operation-createIndexes/)
    assert.match(result.stderr, /migration-runStartupMigrations/)
    assert.match(result.stderr, /mongo-server-error/)
    assert.doesNotMatch(result.stdout + result.stderr, /private-token|CannotCreateIndex|console\.json/)
    writeFileSync(file, JSON.stringify({Log: 'private-token-must-not-print MongoServerError code: 85 index "test_runs_native_history" already exists as "startedAt_-1_runId_-1"'}))
    const conflict = spawnSync("bash", ["-c", `${functions}\nstartup_failure_codes "$SAMPLE"`], {
      env: {...process.env, SAMPLE: file}, encoding: "utf8",
    })
    assert.match(conflict.stderr, /mongo-code-85/)
    assert.match(conflict.stderr, /mongo-index-test_runs_native_history/)
    assert.match(conflict.stderr, /mongo-index-startedAt_-1_runId_-1/)
    assert.doesNotMatch(conflict.stdout + conflict.stderr, /private-token|already exists/)
    writeFileSync(file, 'private-token-must-not-print code: 999999 arbitraryMigration arbitraryOperation private_test_runs_native_history_suffix')
    const unknown = spawnSync("bash", ["-c", `${functions}\nstartup_failure_codes "$SAMPLE"`], {
      env: {...process.env, SAMPLE: file}, encoding: "utf8",
    })
    assert.equal(unknown.stderr.trim(), "Azure startup hint: unknown")
  } finally {rmSync(root, {recursive: true, force: true})}
})

test("standalone diagnostics use only read commands against the fixed Core resource", () => {
  const root = mkdtempSync(path.join(tmpdir(), "azure-current-"))
  try {
    const bin = path.join(root, "bin")
    mkdirSync(bin)
    const fakeAz = `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$COMMANDS"
case "$*" in
  *"--name ca-mentra-ent-ref-core "*"--resource-group rg-mentra-enterprise-reference "*) ;;
  *) exit 99 ;;
esac
case "$*" in
  *'latest:properties.latestRevisionName'*) echo '{"latest":"core-new","ready":"core-old","image":"registry/cloud@sha256:aaa"}' ;;
  "containerapp show"*) echo '{"latestRevision":"core-new","latestReadyRevision":"core-old","provisioningState":"Succeeded"}' ;;
  "containerapp revision show"*) echo '{"name":"core-new","active":true,"provisioningState":"Provisioned","healthState":"None","runningState":"Activating","images":["registry/cloud@sha256:aaa"]}' ;;
  "containerapp replica list"*) echo '[]' ;;
  "containerapp logs show"*) echo 'private-token-must-not-print MongoServerError code: 9 updateMany runStartupMigrations' ;;
  *) exit 99 ;;
esac
`
    writeFileSync(path.join(bin, "az"), fakeAz, {mode: 0o755})
    writeFileSync(path.join(bin, "timeout"), '#!/usr/bin/env bash\n[[ "$1" == 8s ]] || exit 99\nshift\nexec "$@"\n', {mode: 0o755})
    const commands = path.join(root, "commands")
    const result = spawnSync("bash", [new URL("./azure-readiness-diagnostics.sh", import.meta.url).pathname], {
      env: {...process.env, PATH: `${bin}:${process.env.PATH}`, COMMANDS: commands, RUNNER_TEMP: root}, encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /mongo-code-9/)
    assert.match(result.stderr, /mongo-operation-updateMany/)
    assert.doesNotMatch(result.stdout + result.stderr, /private-token/)
    const calls = readFileSync(commands, "utf8").trim().split("\n")
    assert.equal(calls.length, 7)
    for (const call of calls) assert.match(call, /^containerapp (show|revision show|replica list|logs show) /)
    assert.match(calls.at(-1), /--revision core-new .*--type console --tail 30 --format json/)
  } finally {rmSync(root, {recursive: true, force: true})}
})

test("diagnostic workflow is dev-only, manual and has no deployment permissions or commands", () => {
  const workflow = readFileSync(new URL("../workflows/azure-core-startup-diagnostics.yml", import.meta.url), "utf8")
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /github\.ref == 'refs\/heads\/dev'/)
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /bash \.github\/scripts\/azure-readiness-diagnostics\.sh/)
  assert.doesNotMatch(workflow, /push:|pull_request:|actions: write|packages: write|az .* (create|update|restart|delete)/)
})
