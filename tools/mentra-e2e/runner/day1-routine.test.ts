import {afterEach, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {
  createDay1Routine,
  day1RoutineSourcePaths,
  type Day1RoutineInputs,
  type Day1RoutineRuntime,
} from "./day1-routine"
import type {Day1FullOtaInputs, Day1FullOtaInvocation} from "./day1-full-ota"
import {assertFirmwareState, parseFirmwareProfile} from "./firmware-profile"
import type {AssertionStep, Json, LifecycleContext, MutationIntent, MutationStep} from "./lifecycle"
import {runLifecycle} from "./lifecycle"

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, {recursive: true, force: true})))
})
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const owner = "00000000-1111-2222-3333-444444444444",
  stageOwner = "11111111-1111-2222-3333-444444444444"
const unavailable = async (): Promise<never> => {
  throw new Error("Unexpected hardware callback in composition test")
}
const assertion = (id: string): AssertionStep => ({
  id,
  kind: "assertion",
  instruction: `Synthetic test ${id}`,
  observe: async () => ({
    passed: true,
    expected: true,
    actual: true,
    source: "Fake-only test",
    observedAt: new Date().toISOString(),
    evidence: ["test.json"],
  }),
})

async function harness() {
  const folder = await mkdtemp(join(tmpdir(), "day1-composition-"))
  folders.push(folder)
  const put = async (name: string, value: unknown) => {
    const path = join(folder, name),
      data = Buffer.from(JSON.stringify(value) + "\n")
    await mkdir(join(path, ".."), {recursive: true, mode: 0o700})
    await writeFile(path, data, {mode: 0o600})
    return {path, sha256: sha(data)}
  }
  const head = "a".repeat(40),
    build = "b".repeat(40)
  const url = `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/ota-pr-4136-${head}.json`
  const manifest = await put("manifest.json", {
    apps: {
      "com.mentra.asg_client": {
        versionCode: 303006291,
        apkUrl: "https://example.test/asg.apk",
        sha256: "a".repeat(64),
        apkSize: 123,
      },
    },
    bes_firmware: {version: "26.9.21.3", url: "https://example.test/bes.bin", sha256: "b".repeat(64)},
    mtk_full_ota: {
      end_firmware: "MentraLive_20260921.0",
      url: "https://example.test/full.zip",
      sha256: "c".repeat(64),
      size: 12345,
    },
  })
  const profile = parseFirmwareProfile(await readFile(manifest.path), {url, sha256: manifest.sha256})
  const appManifest = await put("app.json", {
    pr: 4136,
    headSha: head,
    buildSha: build,
    runId: 42,
    runAttempt: 1,
    bundleId: "com.mentra.mentra",
    app: "Mentra.app",
    backend: "dev",
    otaManifestUrl: url,
    macPackageVersion: 2,
    macInstaller: "Install Mentra.app",
    mobileFingerprint: "c".repeat(64),
    mobileSourceCommit: build,
    reusedCompilation: false,
    version: "3.3.0",
    build: "303006291",
    executableSha256: "d".repeat(64),
    javascriptSha256: "e".repeat(64),
    profileUUID: owner,
    profileExpires: "2030-01-01T00:00:00Z",
    teamId: "T5XXXL6N36",
  })
  const fixture = {
    cid: "0123456789abcdef0123456789abcdef",
    bluetooth: "AA:BB:CC:DD:EE:01",
    serials: ["TEST012345"],
    wifiEndpoint: "192.168.50.20:5555",
  }
  const config = await put("bes.json", {
    fixture: {cid: fixture.cid, mac: fixture.bluetooth, serial_aliases: fixture.serials},
  })
  const template = await put("january-template.json", {
    python: "/usr/bin/python3",
    lease: {path: join(folder, "lease")},
    fixture: {cid: fixture.cid, mac: fixture.bluetooth, serialAliases: fixture.serials},
  })
  const probe = "c0488244fe62e24f0ca2c855355de01bc687d1d8ae762336e2fc0405e5e42a8e"
  const input: Day1RoutineInputs = {
    appManifest,
    manifest,
    profile,
    fixture,
    returnProfileDigest: "f".repeat(64),
    sources: await Promise.all(day1RoutineSourcePaths.map(async (path) => ({path, sha256: sha(await readFile(path))}))),
    runtimeSource: await put("trusted-runtime.json", {synthetic: true}),
    bes: {config, python: "/usr/bin/python3", adapterDirectory: "/trusted/day1-bes"},
    january: {template, python: "/usr/bin/python3", adapterDirectory: "/trusted/day1-setup"},
    restore: {
      profile,
      fixture,
      artifact: {path: join(folder, "full.zip"), sha256: profile.mtk.artifact.sha256, size: 12345},
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
    },
  }
  const created: Day1FullOtaInputs[] = [],
    commands: Day1FullOtaInvocation[] = []
  let returnValue: Awaited<ReturnType<Day1RoutineRuntime["collectReturn"]>> | undefined
  const runtime: Day1RoutineRuntime = {
    bes: {readCurrentState: unavailable, invoke: unavailable},
    january(inputs) {
      created.push(structuredClone(inputs))
      return {
        async readCurrentState() {
          const now = Date.now() / 1000
          return {
            current: {
              startedAt: now,
              finishedAt: now,
              bootBefore: owner,
              bootAfter: owner,
              identity: {},
              engineStatus: "UPDATE_STATUS_IDLE",
            },
            evidence: [join(folder, "current.json")],
          }
        },
        async invoke(command) {
          commands.push(command)
          return {
            exitCode: 0,
            evidence: [join(folder, "reconcile.json")],
            stdout: JSON.stringify({
              status: command.stageOwner ? "satisfied" : "settled",
              reason: "synthetic_observation",
              owner: command.stageOwner,
              evidence: [],
              setupOnly: true,
              fixtureReadyForOtherRoutines: false,
            }),
          }
        },
      }
    },
    customer: {prepare: unavailable, recording: unavailable, idle: unavailable, verifyTarget: unavailable},
    restore: {
      read: unavailable,
      verifyArtifact: unavailable,
      transfer: unavailable,
      stage: unavailable,
      readStageEvidence: unavailable,
      reboot: unavailable,
    },
    preflight: [assertion("actual-selected-app-preflight")],
    beforeSetup: [assertion("stop-selected-app")],
    beforeCustomer: [assertion("launch-selected-app")],
    beforeRestore: [assertion("stop-before-restore")],
    afterRestore: [assertion("launch-after-restore")],
    async collectReturn() {
      if (!returnValue) throw new Error("Return value absent")
      return returnValue
    },
    recording: {
      ci: {
        claim: {path: join(folder, "claims/absent.json"), sha256: "a".repeat(64)},
        trust: {path: join(folder, "trust.json"), sha256: "b".repeat(64)},
      },
      bind: unavailable,
      finish: unavailable,
    },
  }
  const composition = createDay1Routine(input, runtime)
  const runDirectory = join(folder, "run")
  await mkdir(runDirectory, {mode: 0o700})
  const operations: MutationIntent[] = []
  const context: LifecycleContext = {
    runDirectory,
    selection: {
      runID: "request-test",
      fixtureID: "test-pair",
      returnProfileDigest: input.returnProfileDigest,
      inputs: {
        adapter: composition.inputs,
        request: {
          selection: {
            app: JSON.parse((await readFile(appManifest.path)).toString()),
            otaManifest: {url, sha256: manifest.sha256, size: (await readFile(manifest.path)).length},
          },
        },
      },
    },
    operations,
  }
  const bes = async () => {
    const continuity = {
      schemaVersion: 1,
      kind: "verified-install-continuity",
      sourceBoot: owner,
      besOwner: `adb-bes-${"b".repeat(32)}`,
      installIntent: await put("run/day1-bes/dispatch/install-intent.json", {owner}),
      installLog: await put("run/day1-bes/handshake.log", {fakeNativeProof: true}),
      versionLog: await put("run/day1-bes/observations/version.log", {fakeVersionProof: true}),
    }
    const operation: MutationIntent = {
      operationID: owner,
      stepID: "day1-bes-install",
      phase: "setup",
      startedAt: new Date().toISOString(),
      reconciliation: {
        status: "satisfied",
        expected: "Fake BES test completion",
        actual: {
          adapter: "compact-january-bes-v1",
          adapterRunDirectory: join(runDirectory, "day1-bes"),
          configSha256: config.sha256,
          lifecycleOwner: owner,
          nativeOwner: continuity.besOwner,
          setupOnly: true,
          fixtureReadyForOtherRoutines: false,
          continuityInput: continuity,
        },
        observedAt: new Date().toISOString(),
        source: "Fake-only test",
        evidence: [continuity.versionLog.path],
      },
    }
    operations.push(operation)
    return operation
  }
  const step = (id: string) => composition.routine.setup.find((step) => step.id === id) as MutationStep
  return {
    folder,
    input,
    runtime,
    composition,
    context,
    operations,
    bes,
    step,
    created,
    commands,
    put,
    setReturn(value: Awaited<ReturnType<Day1RoutineRuntime["collectReturn"]>>) {
      returnValue = value
    },
  }
}

test("composition keeps explicit app/transport hooks ordered and construction does not run them", async () => {
  const h = await harness()
  expect(h.created).toHaveLength(0)
  expect(h.commands).toHaveLength(0)
  expect(h.composition.routine.setup.map((step) => step.id)).toEqual([
    "stop-selected-app",
    "day1-bes-install",
    "day1-full-ota-stage",
    "day1-full-ota-activate",
    "launch-selected-app",
  ])
  expect(h.composition.routine.test.map((step) => step.id)).toEqual(["customer-sequence"])
  expect(h.composition.routine.teardown.map((step) => step.id)).toEqual([
    "day1-before-restore-idle",
    "stop-before-restore",
    "restore-mtk-stage",
    "restore-mtk-activate",
    "launch-after-restore",
  ])
  h.runtime.beforeSetup.push(assertion("unbound-hook"))
  expect(h.composition.routine.setup.some((step) => step.id === "unbound-hook")).toBe(false)
  expect(createDay1Routine(h.input, h.runtime).definitionDigest).not.toBe(h.composition.definitionDigest)
})

test("persisted BES continuity deterministically creates private January inputs and recovery never dispatches", async () => {
  const h = await harness()
  await h.bes()
  expect((await h.step("day1-full-ota-stage").reconcile(h.context)).status).toBe("settled")
  const generated = h.created[0],
    original = await readFile(generated.config.path)
  const cfg = JSON.parse(original.toString())
  expect(cfg.lease).toEqual({path: join(h.folder, "lease")})
  expect(cfg).not.toHaveProperty("ownerPid")
  expect((await stat(generated.config.path)).mode & 0o777).toBe(0o600)
  expect(sha(await readFile(cfg.besInstallProof.path))).toBe(cfg.besInstallProof.sha256)
  const intent: MutationIntent = {
    operationID: stageOwner,
    stepID: "day1-full-ota-stage",
    phase: "setup",
    startedAt: new Date().toISOString(),
  }
  h.operations.push(intent)
  const restarted = createDay1Routine(h.input, h.runtime)
  const recovered = await (restarted.routine.setup.find((step) => step.id === intent.stepID) as MutationStep).reconcile(
    h.context,
    intent,
  )
  expect(recovered.status).toBe("satisfied")
  expect(h.created[1]).toEqual(generated)
  expect(await readFile(generated.config.path)).toEqual(original)
  expect(h.commands.every((command) => command.kind === "reconciliation")).toBe(true)
  expect(h.commands.at(-1)?.stageOwner).toBe(stageOwner)
})

test("unknown, wrong-owner and foreign-attempt BES proof cannot authorize January setup", async () => {
  const h = await harness()
  await expect(h.step("day1-full-ota-stage").reconcile(h.context)).rejects.toThrow("persisted same-owner")
  const operation = await h.bes(),
    saved = structuredClone(operation.reconciliation!)
  operation.reconciliation!.status = "unknown"
  await expect(h.step("day1-full-ota-stage").reconcile(h.context)).rejects.toThrow("persisted same-owner")
  operation.reconciliation = structuredClone(saved)
  ;(operation.reconciliation.actual as Record<string, Json>).lifecycleOwner = stageOwner
  await expect(h.step("day1-full-ota-stage").reconcile(h.context)).rejects.toThrow("persisted same-owner")
  operation.reconciliation = structuredClone(saved)
  const value = operation.reconciliation.actual as any
  value.continuityInput.installLog.path = join(h.folder, "other-attempt.log")
  await expect(h.step("day1-full-ota-stage").reconcile(h.context)).rejects.toThrow("another attempt")
  expect(h.created).toHaveLength(0)
  expect(h.commands).toHaveLength(0)
})

test("a created stage requires the original unchanged deferred files; no recovery recreation", async () => {
  const h = await harness()
  const bes = await h.bes()
  await h.step("day1-full-ota-stage").reconcile(h.context)
  const generated = h.created[0],
    intent: MutationIntent = {
      operationID: stageOwner,
      stepID: "day1-full-ota-stage",
      phase: "setup",
      startedAt: new Date().toISOString(),
    }
  h.operations.push(intent)
  const proof = (bes.reconciliation!.actual as any).continuityInput
  proof.versionLog = await h.put("run/day1-bes/observations/replaced.log", {changed: true})
  await expect(h.step(intent.stepID).reconcile(h.context, intent)).rejects.toThrow("differ from original")
  await rm(generated.config.path)
  await expect(h.step(intent.stepID).reconcile(h.context, intent)).rejects.toThrow()
  expect(await Bun.file(generated.config.path).exists()).toBe(false)
  expect(h.commands).toHaveLength(1)
})

test("changed source, missing dependency, changed selected profile and duplicate hooks fail closed", async () => {
  const h = await harness()
  await h.composition.routine.preflight[0].observe(h.context)
  await writeFile(h.input.runtimeSource.path, "changed\n")
  await expect(h.composition.routine.preflight[0].observe(h.context)).rejects.toThrow("frozen input changed")
  expect(() => createDay1Routine({...h.input, sources: h.input.sources.slice(1)}, h.runtime)).toThrow(
    "required dependency",
  )
  const changed = structuredClone(h.input)
  changed.restore.profile = structuredClone(changed.profile)
  changed.restore.profile.bes.version = "26.9.21.4"
  expect(() => createDay1Routine(changed, h.runtime)).toThrow("selected profile")
  h.runtime.afterRestore.push(assertion("day1-bes-install"))
  expect(() => createDay1Routine(h.input, h.runtime)).toThrow("unique")
})

test("a different requested app or OTA artifact is rejected before any setup callback", async () => {
  const h = await harness()
  const wrong = structuredClone(h.context.selection.inputs) as any
  wrong.request.selection.app.build = "999"
  await expect(
    h.composition.routine.preflight[0].observe({...h.context, selection: {...h.context.selection, inputs: wrong}}),
  ).rejects.toThrow("consumed CI request")
  wrong.request.selection.app.build = JSON.parse((await readFile(h.input.appManifest.path)).toString()).build
  wrong.request.selection.otaManifest.sha256 = "0".repeat(64)
  await expect(
    h.composition.routine.preflight[0].observe({...h.context, selection: {...h.context.selection, inputs: wrong}}),
  ).rejects.toThrow("consumed CI request")
  expect(h.commands).toHaveLength(0)
})

test("the return phase requires current complete selected component, idle and app proof", async () => {
  const h = await harness(),
    at = new Date().toISOString(),
    evidence = join(h.folder, "combined-return.json")
  const firmwareAssertions = assertFirmwareState(h.input.profile, h.input.fixture, {
    ...h.input.fixture,
    serial: h.input.fixture.serials[0],
    at,
    evidence,
    bootId: owner,
    bootCompleted: true,
    firmware: h.input.profile.mtk.version,
    asgVersion: h.input.profile.asg.versionCode,
    activeApkSha256: h.input.profile.asg.artifact.sha256,
    bes: {version: h.input.profile.bes.version, at, bootId: owner, evidence},
    updateIdle: true,
    appConnected: true,
  })
  const result = {
    mode: "collect" as const,
    finishedAt: at,
    scope: "Fake-only combined return",
    appConnection: "observed-connected",
    fixtureStateChanged: false,
    returnObservationPassed: true,
    adbQualified: true,
    appEvidence: evidence,
    slot: "_b",
    apkPath: "/data/app/test/base.apk",
    idleChecks: [{passed: true, id: "fake-idle", expected: true, actual: true, evidence: [evidence]}],
    streamStopped: true,
    firmwareAssertions,
  }
  h.setReturn({result, evidence: [evidence]})
  const observe = () => h.composition.routine.returnVerification[0].observe(h.context)
  expect((await observe()).passed).toBe(true)
  result.firmwareAssertions[0].status = "failed"
  expect((await observe()).passed).toBe(false)
  result.firmwareAssertions.find((check) => check.id === "firmware.bes.version")!.expected = "26.9.21.4"
  await expect(observe()).rejects.toThrow("another profile")
})

test("missing consumed claim cannot start or export a fabricated CI recording", async () => {
  const h = await harness()
  await expect(h.composition.routine.preflight.at(-1)!.observe(h.context)).rejects.toThrow()
  await expect(h.composition.exportCompleted(join(h.folder, "export"))).rejects.toThrow()
  expect(await Bun.file(join(h.folder, "export/run.json")).exists()).toBe(false)
})

test("final customer assertion rechecks target and idle before restore without forgiving original failure", async () => {
  const h = await harness(),
    calls: string[] = []
  let target = true,
    idle: "settled" | "active" = "settled"
  const proof = () => ({
    expected: true,
    actual: true,
    observedAt: new Date().toISOString(),
    source: "Fake-only current read",
    evidence: [join(h.folder, "fresh.json")],
  })
  h.runtime.customer.verifyTarget = async () => {
    calls.push("target")
    return {...proof(), passed: target}
  }
  h.runtime.customer.idle = async () => {
    calls.push("idle")
    return {...proof(), status: idle}
  }
  const c = createDay1Routine(h.input, h.runtime)
  const operation: MutationIntent = {
    operationID: stageOwner,
    stepID: "customer-sequence",
    phase: "test",
    startedAt: new Date().toISOString(),
    dispatch: {
      kind: "ota-customer-sequence/v1",
      operationID: stageOwner,
      progress: {started: true, finished: true, installPasses: 3},
      failed: false,
      error: null,
      reportingError: null,
    },
  }
  h.operations.push(operation)
  const observe = () => c.routine.finalAssertions[0].observe(h.context)
  expect((await observe()).passed).toBe(true)
  expect(calls).toEqual(["target", "idle"])
  target = false
  expect((await observe()).passed).toBe(false)
  target = true
  idle = "active"
  expect((await observe()).passed).toBe(false)
  idle = "settled"
  ;(operation.dispatch as Record<string, Json>).failed = true
  calls.length = 0
  expect((await observe()).passed).toBe(false)
  expect(calls).toEqual(["idle"])
  expect(h.commands).toHaveLength(0)
})

test("a fresh active final observation blocks app-stop and all teardown mutations through the real lifecycle", async () => {
  const h = await harness()
  const proof = () => ({
    expected: true,
    actual: true,
    observedAt: new Date().toISOString(),
    source: "Fake-only fresh proof",
    evidence: [join(h.folder, "current.json")],
  })
  h.runtime.customer.verifyTarget = async () => ({...proof(), passed: true})
  h.runtime.customer.idle = async () => ({...proof(), status: "active"})
  const composed = createDay1Routine(h.input, h.runtime)
  let stops = 0
  const customer: MutationStep = {
    id: "customer-sequence",
    kind: "mutation",
    repeat: "never",
    instruction: "Synthetic completed customer operation",
    execute: async (_c, intent) => ({
      kind: "ota-customer-sequence/v1",
      operationID: intent.operationID,
      progress: {started: true, finished: true, installPasses: 1},
      failed: false,
      error: null,
      reportingError: null,
    }),
    reconcile: async (_c, intent) => ({...proof(), status: intent ? "satisfied" : "settled"}),
  }
  const stop: MutationStep = {
    id: "stop-before-restore",
    kind: "mutation",
    repeat: "never",
    instruction: "Synthetic app stop",
    execute: async () => {
      stops++
    },
    reconcile: async (_c, intent) => ({...proof(), status: intent ? "satisfied" : "settled"}),
  }
  const result = await runLifecycle({
    runDirectory: join(h.folder, "lifecycle-gate"),
    fixtureDirectory: join(h.folder, "fixture-gate"),
    selection: h.context.selection,
    acquireLease: async () => async () => {},
    routine: {
      ...composed.routine,
      preflight: [assertion("test-preflight")],
      setup: [],
      test: [customer],
      teardown: [composed.routine.teardown[0], stop],
      returnVerification: [assertion("test-return")],
      evidence: [assertion("test-evidence")],
    },
  })
  expect(stops).toBe(0)
  expect(result.test).toBe("failed")
  expect(result.fixture).toBe("recovery-required")
  const state = JSON.parse(await readFile(join(h.folder, "lifecycle-gate/state.json"), "utf8"))
  expect(state.pendingReconciliation).toEqual({phase: "teardown", stepID: "day1-before-restore-idle"})
  expect(state.operations.map((op: MutationIntent) => op.stepID)).toEqual(["customer-sequence"])
})
