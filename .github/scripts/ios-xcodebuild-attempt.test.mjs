import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"
import test from "node:test"

const wrapper = fileURLToPath(new URL("ios-xcodebuild-attempt.sh", import.meta.url))
const build = fileURLToPath(new URL("../../mobile/ci/pr-ios/build.mjs", import.meta.url))

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "ios-attempt-"))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  mkdirSync(path.join(root, "bin"))
  const fake = (name, source) => writeFileSync(path.join(root, "bin", name), source, {mode: 0o755})
  // Avoid sampling the host in these command-contract tests.
  fake("memory_pressure", "#!/bin/sh\nexit 0\n")
  fake("vm_stat", "#!/bin/sh\nexit 0\n")
  return {root, fake, env: {...process.env, PATH: `${root}/bin:${process.env.PATH}`,
    IOS_BUILD_LOG_DIR: path.join(root, "logs"), GITHUB_OUTPUT: path.join(root, "outputs")}}
}

for (const status of [0, 65]) {
  test(`logging preserves build exit ${status}, timing and signing failure classification`, (t) => {
    const {root, fake, env} = fixture(t)
    // A diagnostic filter failure must not decide whether compilation passed.
    fake("xcbeautify", "#!/bin/sh\ncat >/dev/null\nexit 7\n")
    const result = spawnSync("bash", [wrapper, "attempt-1", "--", "sh", "-c",
      `printf 'CompileC sample.o\nBuild Timing Summary\nCompileC 1.2 seconds\n'; echo failure_kind=signing >> "$GITHUB_OUTPUT"; exit ${status}`,
    ], {env, encoding: "utf8", timeout: 15_000})
    assert.equal(result.status, status, result.stderr)
    const outputs = readFileSync(env.GITHUB_OUTPUT, "utf8")
    assert.match(outputs, new RegExp(`status=${status}\\n`))
    assert.match(outputs, /failure_kind=signing\n/)
    assert.match(outputs, /duration_seconds=\d+\n/)
    assert.match(readFileSync(path.join(root, "logs/xcodebuild-attempt-1.log"), "utf8"), /CompileC sample.o/)
    assert.match(readFileSync(path.join(root, "logs/xcodebuild-attempt-1.timing.txt"), "utf8"), /^Build Timing Summary/)
    assert.match(readFileSync(path.join(root, "logs/xcodebuild-attempt-1.timeline"), "utf8"), /\d+\.\d CompileC sample.o/)
  })
}

test("serial recovery uses one job even if retired experimental flags are inherited", (t) => {
  const {root, fake, env} = fixture(t)
  mkdirSync(path.join(root, "mobile/ios"), {recursive: true})
  fake("xcodebuild", `#!/bin/sh\nprintf '%s\\n' "$@" > "$ARGUMENTS_FILE"\nexit 0\n`)
  const result = spawnSync(process.execPath, [build, "--serial"], {cwd: root,
    env: {...env, PR_IOS_SIGNED: "false", ARGUMENTS_FILE: path.join(root, "args"),
      MENTRA_IOS_EXPERIMENT_PARALLEL: "1", MENTRA_IOS_XCODEBUILD_EXTRA_ARGS_STR: "-parallelizeTargets -jobs 8"},
    encoding: "utf8", timeout: 15_000})
  assert.equal(result.status, 0, result.stderr)
  const args = readFileSync(path.join(root, "args"), "utf8").trim().split("\n")
  assert.equal(args[0], "build")
  assert.deepEqual(args.filter((arg, i) => args[i - 1] === "-jobs"), ["1"])
  assert.ok(args.includes("-showBuildTimingSummary"))
  assert.ok(!args.includes("-parallelizeTargets"))
  assert.ok(!args.includes("-resultBundlePath"))
  assert.ok(args.includes("CODE_SIGNING_ALLOWED=NO"))
})

test("real vm_stat rows survive sampling and missing pageout counters stay unavailable", (t) => {
  const {root, fake, env} = fixture(t)
  fake("memory_pressure", "#!/bin/sh\necho 'System-wide memory free percentage: 20%'\n")
  fake("vm_stat", `#!/bin/sh
if [ -f "$COUNTER_FILE" ]; then count=142; else count=42; fi
touch "$COUNTER_FILE"
printf 'Pages free: 123.\nPages active: 234.\nPages inactive: 345.\nPageouts: %s.\nSwapouts: 5.\n' "$count"
`)
  fake("sleep", '#!/bin/sh\nif [ "$1" = 10 ]; then exec /bin/sleep 0.05; else exec /bin/sleep "$@"; fi\n')
  const memory = path.join(env.IOS_BUILD_LOG_DIR, "xcodebuild-attempt-1.memory")
  const result = spawnSync("bash", [wrapper, "attempt-1", "--", "sh", "-c",
    'while [ ! -f "$MEMORY_FILE" ] || [ "$(wc -l < "$MEMORY_FILE")" -lt 2 ]; do /bin/sleep 0.05; done',
  ], {env: {...env, MEMORY_FILE: memory, COUNTER_FILE: path.join(root, "counter")}, encoding: "utf8", timeout: 15_000})
  assert.equal(result.status, 0, result.stderr)
  const samples = readFileSync(memory, "utf8")
  assert.match(samples, /Pagesfree=123 Pagesactive=234 Pagesinactive=345 Pageouts=42 Swapouts=5/)
  assert.match(samples, /Pageouts=142/)
  const parser = fileURLToPath(new URL("ios-build-timeline.py", import.meta.url))
  const parse = () => {
    const parsed = spawnSync("python3", ["-c",
      "import json,runpy,sys; print(json.dumps(runpy.run_path(sys.argv[1])['parse_memory'](sys.argv[2])))", parser, memory,
    ], {encoding: "utf8"})
    assert.equal(parsed.status, 0, parsed.stderr)
    return JSON.parse(parsed.stdout)
  }
  assert.deepEqual(parse().slice(0, 2), [20, 100])
  writeFileSync(memory, samples.replace(/Pageouts=\d+/g, ""))
  assert.deepEqual(parse().slice(0, 2), [20, null])
  writeFileSync(memory, "0 free percentage: 20% Pageouts=42\n")
  assert.deepEqual(parse(), [20, null, 1])
})
