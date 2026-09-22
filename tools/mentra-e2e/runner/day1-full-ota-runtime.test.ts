import {expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {createDay1FullOtaRuntime} from "./day1-full-ota-runtime"
import type {Day1FullOtaInputs, Day1FullOtaRuntimeContext} from "./day1-full-ota"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
async function temporary(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "mentra-january-runtime-"))
  try {
    await body(root)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
}
async function setup(root: string, extra = "") {
  const config = join(root, "config.json")
  await writeFile(config, "{}", {mode: 0o600})
  const adapter = join(root, "adapter")
  const run = join(root, "run")
  await mkdir(adapter)
  await mkdir(run)
  const python = Bun.which("python3")!
  const program = `import hashlib,json,os,sys,time
from pathlib import Path
args=sys.argv[1:]
assert args[0]=='observe'
out=Path(args[args.index('--out')+1]);out.mkdir(mode=0o700)
assert not Path(args[args.index('--run')+1]).exists()
now=time.time()
current={'startedAt':now,'finishedAt':now,'bootBefore':'test-boot','bootAfter':'test-boot','identity':{'boot':'test-boot'},'engineStatus':'UPDATE_STATUS_IDLE','firmwareWrites':0}
path=out/'current.json';path.write_text(json.dumps(current));path.chmod(0o600)
${extra}
print(json.dumps({'current':{'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()},'firmwareWrites':0}))
`
  await writeFile(join(adapter, "full_january.py"), program)
  const inputs: Day1FullOtaInputs = {config: {path: config, sha256: hash("{}")}, python, adapterDirectory: adapter}
  const bound: Day1FullOtaRuntimeContext = {
    phase: "stage",
    stageOwner: null,
    adapterRunDirectory: join(run, "day1-full-ota"),
    lifecycle: {
      runDirectory: run,
      operations: [],
      selection: {runID: "synthetic", fixtureID: "synthetic", returnProfileDigest: "synthetic", inputs: {}},
    },
  }
  return {inputs, bound}
}

test("real subprocess observer keeps stage absent and records private commands without implicit probe writes", async () => {
  await temporary(async (root) => {
    const {inputs, bound} = await setup(root)
    const runtime = createDay1FullOtaRuntime(inputs)
    const first = await runtime.readCurrentState(bound)
    const second = await runtime.readCurrentState(bound)
    expect(first.current.engineStatus).toBe("UPDATE_STATUS_IDLE")
    expect(first.evidence).not.toEqual(second.evidence)
    expect(
      await access(bound.adapterRunDirectory).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    const command = JSON.parse(await readFile(first.evidence[0]!, "utf8"))
    expect(command.exitCode).toBe(0)
    expect(command.argv).not.toContain("--stage-missing-probe")
    expect(command.automaticRetry).toBe(false)
    for (const path of first.evidence.filter((path) => !path.endsWith("observation") && path.endsWith(".json")))
      expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

test("probe staging is only an explicit observer option", async () => {
  await temporary(async (root) => {
    const {inputs, bound} = await setup(root)
    const result = await createDay1FullOtaRuntime(inputs, {stageMissingProbe: true}).readCurrentState(bound)
    const command = JSON.parse(await readFile(result.evidence[0]!, "utf8"))
    expect(command.argv).toContain("--stage-missing-probe")
    expect(command.argv).not.toContain("stage")
  })
})

test("nonzero command and exact stdin/stdout remain evidence, with no automatic rerun", async () => {
  await temporary(async (root) => {
    const {inputs, bound} = await setup(root)
    const runtime = createDay1FullOtaRuntime(inputs)
    const result = await runtime.invoke({
      ...bound,
      kind: "reconciliation",
      argv: [
        inputs.python,
        "-c",
        "import sys; print(sys.stdin.read()); print('diagnostic failure',file=sys.stderr); sys.exit(7)",
      ],
      stdin: '{"observed":"synthetic"}',
    })
    expect(result.exitCode).toBe(7)
    expect(JSON.parse(result.stdout)).toEqual({observed: "synthetic"})
    expect(await readFile(result.evidence[2]!, "utf8")).toContain("diagnostic failure")
    expect((await readdir(join(bound.lifecycle.runDirectory, "day1-full-ota-runtime"))).length).toBe(1)
    const started = result.evidence.find((path) => path.endsWith("command-started.json"))!
    expect(JSON.parse(await readFile(started, "utf8")).automaticRetry).toBe(false)
  })
})

test("changed or nonprivate config refuses before spawning or creating command evidence", async () => {
  await temporary(async (root) => {
    const {inputs, bound} = await setup(root)
    const runtime = createDay1FullOtaRuntime(inputs)
    await writeFile(inputs.config.path, "changed")
    await expect(runtime.readCurrentState(bound)).rejects.toThrow("configuration changed")
    await writeFile(inputs.config.path, "{}")
    await chmod(inputs.config.path, 0o644)
    await expect(runtime.readCurrentState(bound)).rejects.toThrow("private")
    expect(await readdir(bound.lifecycle.runDirectory)).toEqual([])
  })
})

test("observer errors stay failed instead of fabricating engine idle", async () => {
  await temporary(async (root) => {
    const {inputs, bound} = await setup(root, "raise RuntimeError('probe missing')")
    await expect(createDay1FullOtaRuntime(inputs).readCurrentState(bound)).rejects.toThrow("observation failed")
    const folders = await readdir(join(bound.lifecycle.runDirectory, "day1-full-ota-runtime"))
    const record = JSON.parse(
      await readFile(join(bound.lifecycle.runDirectory, "day1-full-ota-runtime", folders[0]!, "command.json"), "utf8"),
    )
    expect(record.exitCode).not.toBe(0)
  })
})
