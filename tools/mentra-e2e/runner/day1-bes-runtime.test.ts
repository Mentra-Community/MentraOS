import {expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {createDay1BesStep, type Day1BesInputs, type Day1BesRuntimeContext} from "./day1-bes"
import {createDay1BesRuntime} from "./day1-bes-runtime"
import type {LifecycleContext} from "./lifecycle"

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const owner = "bd80e7eb-0456-4098-afc6-0567b1c4a27a"

async function privateJson(path: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value) + "\n")
  await writeFile(path, bytes, {mode: 0o600})
  await chmod(path, 0o600)
  return {path, sha256: hash(bytes)}
}

async function fixture(
  body: (value: {folder: string; inputs: Day1BesInputs; bound: Day1BesRuntimeContext}) => Promise<void>,
) {
  const folder = await mkdtemp(join(tmpdir(), "mentra-bes-runtime-"))
  try {
    const directory = join(folder, "adapter")
    await mkdir(directory, {mode: 0o700})
    for (const file of [
      "__init__.py",
      "config.py",
      "bes_setup.py",
      "run_once.py",
      "run.py",
      "reconcile.py",
      "test_support.py",
    ])
      await copyFile(join(import.meta.dir, "../adapters/day1-bes", file), join(directory, file))
    const helper = `import json, sys, unittest, hashlib
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import config
from test_support import make_config
cfg=make_config(unittest.TestCase(),Path(sys.argv[2])/'inputs')
row=cfg.data
source=Path(config.__file__)
text=source.read_text()
import re
for name,value in [('RAW_SHA',row['target']['raw']['sha256']),('OTA_SHA',row['target']['ota']['sha256']),('VERIFIER_SHA',row['tools']['verifier']['sha256'])]:
 text=re.sub(r"^"+name+r" = '[a-f0-9]+'$", name+" = '"+value+"'", text, flags=re.M)
source.write_text(text)
row['definition']={name:config.digest(source.parent/name) for name in config.FILES}
print(json.dumps({'row':row,'python':row['tools']['python']['path']}))
`
    const child = Bun.spawn(["python3", "-c", helper, directory, folder], {stdout: "pipe", stderr: "pipe"})
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(stderr)
    const {row, python} = JSON.parse(stdout)
    const adbPath = join(folder, "fake-adb")
    const adb = `#!${python}
import sys, shlex, time
args=sys.argv[1:]
if args==['devices','-l']:
 print('List of devices attached\\n192.168.50.20:5555 device model:OFFLINE_TEST transport_id:7');sys.exit(0)
assert args[:2]==['-t','7'], args
args=args[2:]
if args[0]=='logcat':
 now=time.time()
 print(f'{now:.3f} 1936 2001 I K900BluetoothManager: BES_OTA_DIAG version_proof actual=26.9.21.3 current_boot=65b56b33-bde8-4457-8027-35c8684cc1c9 snapshot={{state=IDLE}}')
 print(f'{now:.3f} 1936 2001 I K900BluetoothManager: UART link ready at fast baud 1152000');sys.exit(0)
assert args[0]=='shell', args
cmd=shlex.split(args[1])
values={('getprop','ro.serialno'):'TEST-DEVICE-01',('cat','/sys/block/mmcblk0/device/cid'):'ab'*16,
 ('cat','/proc/sys/kernel/random/boot_id'):'65b56b33-bde8-4457-8027-35c8684cc1c9',
 ('getprop','ro.custom.ota.version'):'MentraLive_20260921.0',('getprop','persist.mentra.live.mac'):'02:00:00:00:00:01',
 ('getprop','ro.boot.slot_suffix'):'_a',('dumpsys','package','com.mentra.asg_client'):'versionCode=123456',
 ('pm','path','com.mentra.asg_client'):'package:/fake/asg.apk',('sha256sum','/fake/asg.apk'):'e'*64+'  /fake/asg.apk',
 ('pidof','com.mentra.asg_client'):'1936',('cat','/proc/1936/stat'):'1936 (asg test) '+' '.join(['S']+['0']*18+['123']+['0']*3)}
if cmd==['date','+%s']: print(int(time.time()))
elif tuple(cmd) in values: print(values[tuple(cmd)])
else: raise Exception('Offline ADB rejected unexpected command '+repr(cmd))
`
    await writeFile(adbPath, adb, {mode: 0o700})
    row.tools.adb = {path: adbPath, sha256: hash(Buffer.from(adb))}
    // The test process itself owns this lease; Python must be its direct child.
    row.lease.ownerPid = process.pid
    await privateJson(row.lease.path, {pid: process.pid, token: "offline-fixture-lease"})
    const config = await privateJson(join(folder, "inputs/config.json"), row)
    const inputs = {config, python, adapterDirectory: directory}
    const runDirectory = join(folder, "lifecycle")
    await mkdir(runDirectory, {mode: 0o700})
    const lifecycle: LifecycleContext = {
      runDirectory,
      operations: [],
      selection: {runID: "offline-only", fixtureID: "synthetic", returnProfileDigest: "unqualified", inputs: {}},
    }
    const bound = {
      lifecycle,
      adapterRunDirectory: join(runDirectory, "day1-bes"),
      lifecycleOwner: null,
      observationOwner: owner,
    }
    try {
      await body({folder, inputs, bound})
    } catch (error) {
      const diagnostics: string[] = []
      for await (const path of new Bun.Glob("lifecycle/day1-bes-runtime/*/stderr.txt").scan({
        cwd: folder,
        absolute: true,
      }))
        diagnostics.push(await readFile(path, "utf8"))
      throw new Error(`Offline runtime test failed: ${String(error)}\n${diagnostics.join("\n")}`)
    }
  } finally {
    await rm(folder, {recursive: true, force: true})
  }
}

test("real direct Python observer and canonical reconciliation preserve private command/log pins without device writes", async () => {
  await fixture(async ({folder, inputs, bound}) => {
    const runtime = createDay1BesRuntime(inputs)
    const first = await runtime.readCurrentState(bound)
    expect(first.current.observationOwner).toBe(owner)
    expect(first.current.firmwareWrites).toBe(0)
    expect(first.current.pidBefore).toBe(first.current.pidAfter)
    expect(first.current.startTicksBefore).toBe("123")
    expect(hash(await readFile(first.current.log.path))).toBe(first.current.log.sha256)
    expect(await readdir(join(folder, "inputs/claims"))).toEqual([])
    expect(await Bun.file(join(bound.adapterRunDirectory, "owner.json")).exists()).toBe(false)
    for (const path of first.evidence) expect((await stat(path)).mode & 0o777).toBe(0o600)
    const started = JSON.parse(
      await readFile(first.evidence.find((path) => path.endsWith("command-started.json"))!, "utf8"),
    )
    expect(started.argv.slice(0, 3)).toEqual([
      inputs.python,
      join(inputs.adapterDirectory, "run.py"),
      "observe-current",
    ])
    expect(started.lifecycleOwner).toBeNull()
    const step = createDay1BesStep(inputs, runtime)
    const result = await step.reconcile(bound.lifecycle)
    expect(result.status).toBe("settled")
    expect(result.actual).toMatchObject({setupOnly: true, fixtureReadyForOtherRoutines: false, continuityInput: null})
    expect(await readdir(join(folder, "inputs/claims"))).toEqual([])
  })
})

test("changed definition or another lease owner fails before the first Python/ADB observation", async () => {
  for (const change of ["definition", "lease"]) {
    await fixture(async ({inputs, bound}) => {
      if (change === "definition")
        await writeFile(join(inputs.adapterDirectory, "run.py"), "raise Exception('must not execute')\n")
      else {
        const cfg = JSON.parse(await readFile(inputs.config.path, "utf8"))
        await privateJson(cfg.lease.path, {pid: process.pid + 1, token: "offline-fixture-lease"})
      }
      await expect(createDay1BesRuntime(inputs).readCurrentState(bound)).rejects.toThrow(
        change === "definition" ? "definition changed" : "lease owner",
      )
      expect(await readdir(bound.lifecycle.runDirectory)).toEqual([])
    })
  }
})

test("nonzero direct child exit is retained with hashed output and never retried", async () => {
  await fixture(async ({inputs, bound}) => {
    const runtime = createDay1BesRuntime(inputs)
    const result = await runtime.invoke({
      ...bound,
      kind: "reconciliation",
      argv: [inputs.python, "-c", "import sys;print('offline diagnostic');sys.exit(7)"],
    })
    expect(result.exitCode).toBe(7)
    expect(result.stdout.trim()).toBe("offline diagnostic")
    const terminal = JSON.parse(await readFile(result.evidence[0], "utf8"))
    expect(terminal.exitCode).toBe(7)
    expect(terminal.automaticRetry).toBe(false)
    expect(terminal.stdoutSha256).toBe(hash(await readFile(result.evidence[2])))
    expect(await readdir(join(bound.lifecycle.runDirectory, "day1-bes-runtime"))).toHaveLength(1)
  })
})
