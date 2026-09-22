import {afterEach, expect, test} from "bun:test"
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {
  recoverLifecycle,
  runLifecycle,
  type AssertionStep,
  type LifecycleEvent,
  type LifecycleOptions,
} from "./lifecycle"
import {
  createMtkFullRestoreSteps,
  type MtkFullRestoreInputs,
  type MtkFullRestoreRuntime,
  type MtkRestoreIdentity,
  type MtkStageEvidence,
} from "./mtk-full-restore"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, {recursive: true, force: true})))
})
const hash = "a".repeat(64),
  probe = "c0488244fe62e24f0ca2c855355de01bc687d1d8ae762336e2fc0405e5e42a8e"
const oldBoot = "00000000-1111-2222-3333-444444444444",
  newBoot = "11111111-1111-2222-3333-444444444444"
const IDLE = "UPDATE_STATUS_IDLE",
  READY = "UPDATE_STATUS_UPDATED_NEED_REBOOT"
const proof = () => ({
  expected: "independent fixture and writer proof",
  actual: {simulated: true},
  observedAt: new Date().toISOString(),
  source: "fake transport",
  evidence: ["read.json"],
})
function stageEvidence(
  request: Pick<Parameters<MtkFullRestoreRuntime["stage"]>[0], "sourceIntent" | "source" | "argv">,
  exitCode: number | null = 0,
  success = true,
): MtkStageEvidence {
  const s = request.source
  return {
    exitCode,
    sourceIntent: request.sourceIntent,
    argv: request.argv,
    evidence: ["helper/preflight.json", "helper/result.json", "helper/update-logcat.txt"],
    preflight: {
      version: s.firmware,
      slot: s.slot,
      serial: s.serial,
      emmc_cid: s.cid,
      boot_id: s.bootId,
      transport: s.transport,
      usb_path: s.usb ?? null,
      wifi_endpoint: s.wifiEndpoint ?? null,
      ota_sha256: "a".repeat(64),
      ota_size: 12345,
      update_engine: {current_op: "UPDATE_STATUS_IDLE"},
    },
    receipt: {
      success,
      ota_sha256: "a".repeat(64),
      source_version: s.firmware,
      source_slot: s.slot,
      post_identity: {
        version: s.firmware,
        slot: s.slot,
        serial: s.serial,
        boot_id: s.bootId,
        emmc_cid: s.cid,
        transport: s.transport,
        usb_path: s.usb ?? null,
        wifi_endpoint: s.wifiEndpoint ?? null,
      },
      post_update_engine: {current_op: "UPDATE_STATUS_UPDATED_NEED_REBOOT"},
      log_boundary: "mentra-mtk-stage-0123456789abcdef0123456789abcdef",
    },
  }
}
async function harness() {
  const folder = await mkdtemp(join(tmpdir(), "mtk-restore-"))
  directories.push(folder)
  const input: MtkFullRestoreInputs = {
    profile: {
      manifest: {url: "https://example.test/manifest.json", sha256: "b".repeat(64)},
      mtk: {
        version: "MentraLive_20260921.0",
        artifact: {url: "https://example.test/full.zip", sha256: hash, size: 12345},
      },
      bes: {version: "26.9.21.3", artifact: {url: "https://example.test/bes.bin", sha256: hash}},
      asg: {versionCode: 291, artifact: {url: "https://example.test/asg.apk", sha256: hash}},
    },
    fixture: {
      cid: "0123456789abcdef0123456789abcdef",
      bluetooth: "AA:BB:CC:DD:EE:01",
      serials: ["TEST012345"],
      usb: "1-2",
    },
    artifact: {path: join(folder, "full.zip"), sha256: hash, size: 12345},
    python: "/usr/bin/python3",
    helper: {
      path: "/trusted/stage_mtk_ota.py",
      sha256: "00f586a648c96383a9545145d7b44b25bbd2696ce24b8efb166238dde59a8698",
    },
    probe: {
      path: "/trusted/status.jar",
      sha256: probe,
      remote: `/data/local/tmp/mentra-update-engine-status-${probe}.jar`,
    },
  }
  const source: MtkRestoreIdentity = {
    cid: input.fixture.cid,
    serial: "TEST012345",
    bootSerial: "TEST012345",
    bluetooth: input.fixture.bluetooth,
    firmware: "MentraLive_20260113",
    bootId: oldBoot,
    slot: "_a",
    bootCompleted: true,
    transport: "7",
    usb: "1-2",
  }
  const state = {
    identity: structuredClone(source),
    engine: IDLE,
    writersIdle: true,
    power: true,
    held: false,
    artifact: true,
    changeAfterTransfer: false,
    changeBeforeApply: false,
    changeBeforeReboot: false,
    omitGate: false,
    failStage: false,
    delayBoot: false,
  }
  const calls: string[] = [],
    commands: string[][] = []
  const read = async () => {
    expect(state.held).toBe(true)
    calls.push("read")
    return {
      ...proof(),
      identity: structuredClone(state.identity),
      engineStatus: state.engine,
      writersIdle: state.writersIdle,
      powerReady: state.power,
    }
  }
  const runtime = (): MtkFullRestoreRuntime => ({
    read,
    verifyArtifact: async () => {
      calls.push("verify-full-payload")
      return {...proof(), passed: state.artifact}
    },
    transfer: async (request) => {
      expect(state.held).toBe(true)
      const original = JSON.parse(await readFile(request.sourceIntent.path, "utf8"))
      expect(original.operationID).toBe(request.intent.operationID)
      expect(original.source).toEqual(request.source)
      expect((await stat(request.sourceIntent.path)).mode & 0o777).toBe(0o600)
      await request.beforeWrite()
      calls.push("transfer")
      if (state.changeAfterTransfer) state.identity.bootId = newBoot
      return {exitCode: 0, evidence: ["transfer.json"]}
    },
    stage: async (request) => {
      commands.push(request.argv)
      if (state.changeBeforeApply) state.writersIdle = false
      if (!state.omitGate) await request.beforeApply()
      calls.push("apply")
      state.engine = READY
      const result = stageEvidence(request, state.failStage ? 1 : 0, !state.failStage)
      const output = request.argv[request.argv.indexOf("--output") + 1]
      await mkdir(output)
      await writeFile(join(output, "helper-evidence.json"), JSON.stringify(result), {flag: "wx", mode: 0o600})
      return result
    },
    readStageEvidence: async (request) => {
      expect(state.held).toBe(true)
      calls.push("read-original-stage")
      try {
        return JSON.parse(await readFile(join(request.outputDirectory, "helper-evidence.json"), "utf8"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
      }
    },
    reboot: async (request) => {
      commands.push(request.argv)
      if (state.changeBeforeReboot) state.power = false
      await request.beforeReboot()
      calls.push("reboot")
      if (!state.delayBoot) {
        state.identity = {...state.identity, bootId: newBoot, slot: "_b", firmware: input.profile.mtk.version}
        state.engine = IDLE
      }
      return {exitCode: 0, evidence: ["activation.json"]}
    },
  })
  const assertion = (id: string): AssertionStep => ({
    id,
    kind: "assertion",
    instruction: "Read actual evidence.",
    observe: async () => ({...proof(), passed: true}),
  })
  const options: LifecycleOptions = {
    runDirectory: join(folder, "run"),
    fixtureDirectory: join(folder, "fixture"),
    selection: {
      runID: "restore-run",
      fixtureID: input.fixture.cid,
      returnProfileDigest: input.profile.manifest.sha256,
      inputs: {},
    },
    acquireLease: async () => {
      expect(state.held).toBe(false)
      state.held = true
      return async () => {
        state.held = false
      }
    },
    routine: {
      id: "restore-test",
      definitionDigest: "frozen",
      preflight: [assertion("preflight")],
      setup: [],
      test: [],
      finalAssertions: [assertion("target")],
      teardown: createMtkFullRestoreSteps(input, runtime()),
      returnVerification: [assertion("return")],
      evidence: [assertion("evidence")],
    },
  }
  return {folder, input, source, state, calls, commands, runtime, options}
}
async function events(folder: string): Promise<LifecycleEvent[]> {
  return (await readFile(join(folder, "run/events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

test("full MTK restore stages once, closes transfer with source reads, then activates and proves a new target boot", async () => {
  const h = await harness()
  expect(h.calls).toEqual([])
  expect(await runLifecycle(h.options)).toMatchObject({teardown: "passed", fixture: "ready"})
  expect(h.calls.filter((x) => ["transfer", "apply", "reboot"].includes(x))).toEqual(["transfer", "apply", "reboot"])
  const transferred = h.calls.indexOf("transfer"),
    applied = h.calls.indexOf("apply")
  expect(h.calls.slice(transferred + 1, applied).filter((x) => x === "read").length).toBeGreaterThanOrEqual(2)
  const stage = h.commands[0]
  expect(stage.slice(0, 2)).toEqual([h.input.python, h.input.helper.path])
  expect(stage).toContain("--expected-version")
  expect(stage).toContain(h.source.firmware)
  expect(stage).toContain("--sha256")
  expect(stage).toContain(hash)
  expect(stage).toContain("--update-engine-status-jar")
  expect(stage).toContain(h.input.probe.path)
  expect(h.commands[1]).toEqual(["adb", "-t", "7", "reboot"])
  const journal = await events(h.folder),
    ops = journal.at(-1)!.state.operations
  expect(ops.map((op) => op.phase)).toEqual(["teardown", "teardown"])
  expect(ops[1].dispatch).toMatchObject({stageOwner: ops[0].operationID})
  expect(ops.map((op) => op.reconciliation?.status)).toEqual(["satisfied", "satisfied"])
})

test("already-selected MTK and actual idle skips both stages without transferring or rebooting", async () => {
  const h = await harness()
  h.state.identity.firmware = h.input.profile.mtk.version
  expect(await runLifecycle(h.options)).toMatchObject({teardown: "passed", fixture: "ready"})
  expect(h.calls.every((x) => x === "read")).toBe(true)
  expect((await events(h.folder)).at(-1)!.state.operations).toEqual([])
})

test("invalid full proof, writer activity, source change after transfer and final apply/reboot gates fail closed", async () => {
  for (const change of [
    "artifact",
    "writersIdle",
    "changeAfterTransfer",
    "changeBeforeApply",
    "changeBeforeReboot",
  ] as const) {
    const h = await harness()
    h.state[change] = !["artifact", "writersIdle"].includes(change)
    expect(await runLifecycle(h.options)).toMatchObject({fixture: "recovery-required"})
    expect(h.calls).not.toContain("reboot")
    if (change !== "changeBeforeReboot") expect(h.calls).not.toContain("apply")
    if (change === "artifact" || change === "writersIdle") expect(h.calls).not.toContain("transfer")
  }
})

test("missing apply gate or failed helper cannot authorize activation; recovery never resends", async () => {
  for (const key of ["omitGate", "failStage"] as const) {
    const h = await harness()
    h.state[key] = true
    expect(await runLifecycle(h.options)).toMatchObject({fixture: "recovery-required"})
    h.options.routine.teardown = createMtkFullRestoreSteps(h.input, h.runtime())
    expect(await recoverLifecycle(h.options)).toMatchObject({fixture: "recovery-required"})
    expect(h.calls.filter((x) => x === "apply")).toHaveLength(1)
    expect(h.calls).not.toContain("reboot")
  }
})

test("activation uncertainty waits for independent new boot without another reboot or transfer", async () => {
  const h = await harness()
  h.state.delayBoot = true
  expect(await runLifecycle(h.options)).toMatchObject({fixture: "recovery-required"})
  h.options.routine.teardown = createMtkFullRestoreSteps(h.input, h.runtime())
  expect(await recoverLifecycle(h.options)).toMatchObject({fixture: "recovery-required"})
  h.state.identity = {...h.state.identity, bootId: newBoot, slot: "_b", firmware: h.input.profile.mtk.version}
  h.state.engine = IDLE
  expect(await recoverLifecycle(h.options)).toMatchObject({fixture: "ready", teardown: "passed"})
  expect(h.calls.filter((x) => x === "reboot")).toHaveLength(1)
  expect(h.calls.filter((x) => x === "apply")).toHaveLength(1)
})

test("wrong identity or a target pin that differs from the selected manifest cannot restore", async () => {
  const h = await harness()
  h.state.identity.cid = "f".repeat(32)
  expect(await runLifecycle(h.options)).toMatchObject({fixture: "recovery-required"})
  expect(h.calls.every((x) => x === "read")).toBe(true)
  h.input.artifact.sha256 = "f".repeat(64)
  expect(() => createMtkFullRestoreSteps(h.input, h.runtime())).toThrow("artifact mismatch")
})

async function crashAfterHelper(h: Awaited<ReturnType<typeof harness>>) {
  const source = `
    import {mkdir,writeFile} from "node:fs/promises";
    import {join} from "node:path";
    import {runLifecycle} from ${JSON.stringify(new URL("./lifecycle.ts", import.meta.url).href)};
    import {createMtkFullRestoreSteps} from ${JSON.stringify(new URL("./mtk-full-restore.ts", import.meta.url).href)};
    const input=${JSON.stringify(h.input)}, identity=${JSON.stringify(h.source)};
    const proof=${proof.toString()}, stageEvidence=${stageEvidence.toString()};
    const runtime={
      read:async()=>({...proof(),identity,engineStatus:"UPDATE_STATUS_IDLE",writersIdle:true,powerReady:true}),
      verifyArtifact:async()=>({...proof(),passed:true}),
      transfer:async request=>{await request.beforeWrite();return {exitCode:0,evidence:["transfer.json"]}},
      stage:async request=>{
        await request.beforeApply();
        const output=request.argv[request.argv.indexOf("--output")+1];
        await mkdir(output);
        await writeFile(join(output,"helper-evidence.json"),JSON.stringify(stageEvidence(request,null)),{flag:"wx",mode:0o600});
        process.exit(73);
      },
      readStageEvidence:async()=>{throw Error("No initial receipt read")},
      reboot:async()=>{throw Error("Must crash before activation")}
    };
    const assertion=id=>({id,kind:"assertion",instruction:"Read actual evidence.",observe:async()=>({...proof(),passed:true})});
    await runLifecycle({runDirectory:${JSON.stringify(h.options.runDirectory)},fixtureDirectory:${JSON.stringify(h.options.fixtureDirectory)},
      selection:${JSON.stringify(h.options.selection)},acquireLease:async()=>async()=>{},routine:{
        id:"restore-test",definitionDigest:"frozen",preflight:[assertion("preflight")],setup:[],test:[],
        finalAssertions:[assertion("target")],teardown:createMtkFullRestoreSteps(input,runtime),
        returnVerification:[assertion("return")],evidence:[assertion("evidence")]}});
  `
  const child = Bun.spawn([process.execPath, "--eval", source], {stdout: "pipe", stderr: "pipe"})
  expect({code: await child.exited, stderr: await new Response(child.stderr).text()}).toEqual({code: 73, stderr: ""})
  const journal = await events(h.folder)
  expect(journal.at(-1)?.type).toBe("mutation-intent")
  const op = journal.at(-1)!.state.operations[0]
  expect(op.dispatch).toBeUndefined()
  h.state.engine = READY
  h.options.routine.teardown = createMtkFullRestoreSteps(h.input, h.runtime())
  return {op, output: join(h.options.runDirectory, `mtk-full-${op.operationID}`)}
}

test("process crash after original helper receipt reconciles READY and activates once without restaging", async () => {
  const h = await harness()
  const {op} = await crashAfterHelper(h)
  // The original receipt alone cannot satisfy stage while the live engine is not READY.
  h.state.engine = "UPDATE_STATUS_FINALIZING"
  expect(await recoverLifecycle(h.options)).toMatchObject({fixture: "recovery-required"})
  expect(h.calls).not.toContain("reboot")
  h.state.engine = READY
  expect(await recoverLifecycle(h.options)).toMatchObject({teardown: "passed", fixture: "ready"})
  expect(h.calls).toContain("read-original-stage")
  expect(h.calls.filter((x) => ["transfer", "apply", "reboot"].includes(x))).toEqual(["reboot"])
  const operations = (await events(h.folder)).at(-1)!.state.operations
  expect(operations[0].dispatch).toBeUndefined()
  expect(operations[0].reconciliation?.actual).toMatchObject({
    restore: {
      operationID: op.operationID,
      exitCode: null,
      sourceIntent: {path: join(h.options.runDirectory, `mtk-full-${op.operationID}.intent.json`)},
    },
  })
  expect(operations[1].dispatch).toMatchObject({stageOwner: op.operationID})
}, 10000)

test("crash recovery rejects missing apply intent or foreign original owner, source, argv and claim digest", async () => {
  for (const defect of ["apply-intent", "owner", "source", "argv", "claim", "target", "post-slot"] as const) {
    const h = await harness()
    const {output} = await crashAfterHelper(h)
    if (defect === "apply-intent") await rm(`${output}.apply-intent.json`)
    else if (defect === "owner") {
      const intent = JSON.parse(await readFile(`${output}.intent.json`, "utf8"))
      intent.operationID = newBoot
      await writeFile(`${output}.intent.json`, JSON.stringify(intent))
    } else {
      const path = join(output, "helper-evidence.json")
      const result = JSON.parse(await readFile(path, "utf8"))
      if (defect === "source") result.preflight.boot_id = newBoot
      if (defect === "argv") result.argv[result.argv.indexOf("--remote") + 1] = "/storage/another-operation.zip"
      if (defect === "claim") result.sourceIntent.sha256 = "f".repeat(64)
      if (defect === "target") result.receipt.ota_sha256 = "f".repeat(64)
      if (defect === "post-slot") result.receipt.post_identity.slot = "_b"
      await writeFile(path, JSON.stringify(result))
    }
    expect(await recoverLifecycle(h.options)).toMatchObject({fixture: "recovery-required"})
    expect(h.calls.filter((x) => ["transfer", "apply", "reboot"].includes(x))).toEqual([])
  }
}, 10000)
