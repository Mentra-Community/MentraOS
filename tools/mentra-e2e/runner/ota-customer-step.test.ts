import {afterEach, expect, test} from "bun:test"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {
  recoverLifecycle,
  runLifecycle,
  type AssertionStep,
  type LifecycleEvent,
  type LifecycleOptions,
  type MutationStep,
  type Observation,
} from "./lifecycle"
import type {Snapshot} from "./driver"
import type {OtaCustomerActions, OtaCustomerSelection} from "./ota-customer-sequence"
import {createOtaCustomerStep, type OtaCustomerStepRuntime} from "./ota-customer-step"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, {recursive: true, force: true})))
})

function proof(actual: string): Observation {
  return {
    actual,
    expected: "current fixture proof",
    observedAt: new Date().toISOString(),
    source: "simulated independent reader",
    evidence: ["private/observation.json"],
    identity: {cid: "synthetic-fixture"},
  }
}
function screen(page: string): Snapshot {
  const rows =
    page === "home"
      ? [{identifier: "home.miniapp.com.mentra.settings"}]
      : page === "available"
        ? [{identifier: "button-Update Now"}]
        : [{description: "Update Complete"}, {description: "Your glasses are running the latest version."}]
  return {
    elements: rows.map((row) => ({
      role: "AXButton",
      visible: true,
      enabled: true,
      title: "",
      description: "",
      value: "",
      placeholder: "",
      identifier: "",
      ...row,
    })),
  } as Snapshot
}
const selection: OtaCustomerSelection = {
  install: true,
  resume: false,
  minutes: 1,
  before: {bootId: "original", slot: "_a"},
  target: {asgVersion: 291, firmware: "MentraLive_20260921.0", bes: "26.9.21.3"},
}
const initialHardware = {
  serial: "TEST012345",
  cid: "synthetic-fixture",
  bluetooth: "AA:BB:CC:DD:EE:01",
  transport: "7",
  firmware: "MentraLive_20260113",
  bootId: "original",
  slot: "_a",
  bootCompleted: "1",
  asgVersion: 27,
  shell: async () => {
    throw new Error("No hardware in this test")
  },
}

async function harness() {
  const folder = await mkdtemp(join(tmpdir(), "ota-customer-step-"))
  directories.push(folder)
  const state = {
    page: "home",
    prepared: true,
    idle: "settled",
    target: true,
    failPress: false,
    reportFailure: false,
    restored: false,
    staleTarget: false,
    staleIdle: false,
    held: false,
  }
  const calls: string[] = []
  const checkLease = () => {
    expect(state.held).toBe(true)
  }
  const actions: OtaCustomerActions = {
    snapshot: async () => screen(state.page),
    hardware: async () => ({...initialHardware}),
    readBesVersion: async () => {
      throw new Error("Initial January target differs")
    },
    observe: async () => {},
    verifyAppPair: async () => {
      calls.push("pair")
    },
    verifyTarget: async () => {
      calls.push("sequence-target")
    },
    observeHardware: async () => {},
    verifyPublishedManifests: async () => {
      calls.push("manifest")
    },
    executeStep: async (step) => {
      checkLease()
      if (typeof step.action === "function" || step.action?.op !== "relaunch") throw Error("unexpected action")
      calls.push("relaunch")
      state.page = "available"
      return true
    },
    press: async (identifier) => {
      checkLease()
      calls.push(identifier)
      if (identifier === "button-Update Now") {
        if (state.failPress) throw new Error("Original update press became ambiguous")
        state.page = "complete"
      } else if (identifier === "button-Done") state.page = "home"
      else throw new Error("unexpected press")
    },
  }
  const runtime = (): OtaCustomerStepRuntime => ({
    prepare: async () => {
      checkLease()
      calls.push("prepare")
      return {...proof("prepared January"), passed: state.prepared}
    },
    recording: async (context, intent) => {
      checkLease()
      calls.push("recording")
      const events = await journal(folder)
      expect(events.at(-1)?.type).toBe("mutation-intent")
      expect(events.at(-1)?.state.operations.at(-1)?.operationID).toBe(intent.operationID)
      expect(context.operations.at(-1)?.operationID).toBe(intent.operationID)
      return {selection, actions, metadata: {}}
    },
    idle: async () => {
      checkLease()
      calls.push("idle")
      return {
        ...proof("independent updater state"),
        status: state.idle as "settled" | "active" | "unknown",
        ...(state.staleIdle ? {observedAt: "2020-01-01T00:00:00Z"} : {}),
      }
    },
    verifyTarget: async () => {
      checkLease()
      calls.push("independent-target")
      return {
        ...proof("current components and paired home"),
        passed: state.target,
        ...(state.staleTarget ? {observedAt: "2020-01-01T00:00:00Z"} : {}),
      }
    },
    recordFailure: async (error) => {
      calls.push(`failure:${String(error)}`)
      if (state.reportFailure) throw Error("Report write failed")
    },
    clock: {now: () => 0, sleep: async () => {}},
  })
  const assertion = (id: string): AssertionStep => ({
    id,
    kind: "assertion",
    instruction: "Read independent evidence.",
    observe: async () => ({...proof(id), passed: true}),
  })
  const restore: MutationStep = {
    id: "restore",
    kind: "mutation",
    repeat: "never",
    instruction: "Restore selected target.",
    reconcile: async () => ({...proof("restored target"), status: state.restored ? "satisfied" : "settled"}),
    execute: async () => {
      checkLease()
      calls.push("restore")
      state.restored = true
      return {restored: true}
    },
  }
  let retainedLease: Parameters<LifecycleOptions["acquireLease"]>[0] | undefined
  const options: LifecycleOptions = {
    runDirectory: join(folder, "run"),
    fixtureDirectory: join(folder, "fixture"),
    selection: {
      runID: "customer-run",
      fixtureID: "synthetic-fixture",
      returnProfileDigest: "frozen-target",
      inputs: {},
    },
    acquireLease: async (owner) => {
      if (retainedLease) expect(owner).toEqual(retainedLease)
      else expect(state.held).toBe(false)
      retainedLease = undefined
      state.held = true
      return async () => {
        state.held = false
      }
    },
    onLeaseRetained: async (owner) => {
      retainedLease = {recovering: true, runDirectory: owner.runDirectory, selection: owner.selection}
    },
    routine: {
      id: "day1-test",
      definitionDigest: "frozen-definition",
      preflight: [assertion("preflight")],
      setup: [],
      test: [createOtaCustomerStep(runtime())],
      finalAssertions: [assertion("final")],
      teardown: [restore],
      returnVerification: [assertion("return")],
      evidence: [assertion("evidence")],
    },
  }
  return {folder, state, calls, options, runtime}
}
async function journal(folder: string): Promise<LifecycleEvent[]> {
  return (await readFile(join(folder, "run/events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

test("completed sequence needs independent target then closing idle proof under one lifecycle", async () => {
  const h = await harness()
  const result = await runLifecycle(h.options)
  expect(result).toMatchObject({test: "passed", teardown: "passed", fixture: "ready", outcome: "passed"})
  expect(h.calls.filter((call) => call === "button-Update Now")).toHaveLength(1)
  expect(h.calls.indexOf("independent-target")).toBeLessThan(h.calls.indexOf("idle"))
  const events = await journal(h.folder)
  const operation = events.at(-1)!.state.operations[0]
  expect(operation.dispatch).toMatchObject({
    kind: "ota-customer-sequence/v1",
    failed: false,
    error: null,
    progress: {started: true, finished: true, installPasses: 1},
  })
  expect(operation.reconciliation?.status).toBe("satisfied")
})

test("failed but independently idle customer restores without replay, preserving original failure in journal", async () => {
  const h = await harness()
  h.state.failPress = true
  h.state.reportFailure = true
  const result = await runLifecycle(h.options)
  expect(result).toMatchObject({test: "failed", teardown: "passed", fixture: "ready", outcome: "failed"})
  expect(h.calls.filter((call) => call === "button-Update Now")).toHaveLength(1)
  expect(h.calls.filter((call) => call === "restore")).toHaveLength(1)
  expect(h.calls).not.toContain("independent-target")
  const events = await journal(h.folder)
  expect(events.at(-1)!.state.operations[0].dispatch).toMatchObject({
    failed: true,
    error: "Original update press became ambiguous",
    reportingError: "Report write failed",
    progress: {started: true, finished: false, installPasses: 1},
  })
  expect(events.at(-1)!.state.operations[0].reconciliation?.status).toBe("settled")
  expect(events.findIndex((event) => event.type === "test-frozen")).toBeLessThan(
    events.findIndex((event) => event.stepID === "restore"),
  )
})

test("active or unknown failure blocks teardown; a newly constructed step later settles only, retaining failed test", async () => {
  for (const status of ["active", "unknown"]) {
    const h = await harness()
    h.state.failPress = true
    h.state.idle = status
    expect(await runLifecycle(h.options)).toMatchObject({
      test: "failed",
      teardown: "deferred",
      fixture: "recovery-required",
    })
    expect(h.calls).not.toContain("restore")
    h.options.routine.test = [createOtaCustomerStep(h.runtime())] // No old progress/error closure.
    expect(await recoverLifecycle(h.options)).toMatchObject({test: "failed", fixture: "recovery-required"})
    h.state.idle = "settled"
    expect(await recoverLifecycle(h.options)).toMatchObject({
      test: "failed",
      teardown: "passed",
      fixture: "ready",
      outcome: "failed",
    })
    expect(h.calls.filter((call) => call === "recording")).toHaveLength(1)
    expect(h.calls.filter((call) => call === "button-Update Now")).toHaveLength(1)
    expect(h.calls).not.toContain("independent-target")
    const events = await journal(h.folder)
    expect(events.at(-1)!.state.operations[0].dispatch).toMatchObject({
      failed: true,
      error: "Original update press became ambiguous",
    })
  }
})

test("target failure or stale target cannot pass even after a completed loop; idle alone only authorizes restoration", async () => {
  for (const change of ["target", "staleTarget"] as const) {
    const h = await harness()
    h.state[change] = change === "staleTarget"
    expect(await runLifecycle(h.options)).toMatchObject({
      test: "failed",
      teardown: "passed",
      fixture: "ready",
      outcome: "failed",
    })
    expect(h.calls.filter((call) => call === "button-Update Now")).toHaveLength(1)
    expect((await journal(h.folder)).at(-1)!.state.operations[0].reconciliation?.status).toBe("settled")
  }
})

test("stale idle, invalid satisfied-as-idle and unprepared baseline never authorize new work", async () => {
  for (const change of ["staleIdle", "idle", "prepared"] as const) {
    const h = await harness()
    if (change === "idle") h.state.idle = "satisfied"
    else h.state[change] = change === "staleIdle"
    expect(await runLifecycle(h.options)).toMatchObject({
      test: "failed",
      teardown: "deferred",
      fixture: "recovery-required",
    })
    expect(h.calls).not.toContain("restore")
    if (change === "prepared") expect(h.calls).not.toContain("recording")
  }
})

test("reused or foreign durable intents cannot execute or adopt another operation's completion", async () => {
  const h = await harness()
  await runLifecycle(h.options)
  const operations = (await journal(h.folder)).at(-1)!.state.operations
  const intent = operations[0]
  const context = {runDirectory: h.options.runDirectory, selection: h.options.selection, operations}
  const step = createOtaCustomerStep(h.runtime())
  const before = [...h.calls]
  await expect(step.execute(context, intent)).rejects.toThrow("already dispatched")
  await expect(step.execute({...context, operations: []}, intent)).rejects.toThrow("original test-phase")
  const foreign = {...intent, dispatch: {...(intent.dispatch as object), operationID: "another-owner"}}
  await expect(step.reconcile(context, foreign)).rejects.toThrow("another operation")
  expect(h.calls).toEqual(before)
})

test("a distinct teardown customer pass preserves the original failed test and its intent", async () => {
  const h = await harness()
  h.state.failPress = true
  const restoreRuntime = h.runtime()
  h.options.routine.teardown.push(
    createOtaCustomerStep(
      {
        ...restoreRuntime,
        prepare: async (context) => {
          h.state.failPress = false
          h.state.page = "home"
          return restoreRuntime.prepare(context)
        },
      },
      {id: "restore-selected-components", phase: "teardown"},
    ),
  )
  const result = await runLifecycle(h.options)
  expect(result).toMatchObject({test: "failed", teardown: "passed", fixture: "ready", outcome: "failed"})
  const events = await journal(h.folder),
    operations = events.at(-1)!.state.operations
  const original = operations.find((op) => op.stepID === "customer-sequence")!,
    restored = operations.find((op) => op.stepID === "restore-selected-components")!
  expect(original.phase).toBe("test")
  expect(original.dispatch).toMatchObject({failed: true, progress: {started: true, finished: false}})
  expect(restored.phase).toBe("teardown")
  expect(restored.operationID).not.toBe(original.operationID)
  expect(restored.dispatch).toMatchObject({failed: false, progress: {started: true, finished: true}})
  expect(restored.reconciliation?.status).toBe("satisfied")
  expect(h.calls.filter((call) => call === "button-Update Now")).toHaveLength(2)
  expect(events.findIndex((event) => event.type === "test-frozen")).toBeLessThan(
    events.findIndex((event) => event.stepID === restored.stepID),
  )
  const step = createOtaCustomerStep(h.runtime(), {id: restored.stepID, phase: "teardown"})
  const context = {runDirectory: h.options.runDirectory, selection: h.options.selection, operations}
  await expect(step.execute(context, restored)).rejects.toThrow("already dispatched")
  await expect(step.reconcile(context, original)).rejects.toThrow("original teardown-phase")
  const testPhase = {...restored, phase: "test" as const}
  await expect(step.reconcile({...context, operations: [testPhase]}, testPhase)).rejects.toThrow(
    "original teardown-phase",
  )
  expect(h.calls.filter((call) => call === "button-Update Now")).toHaveLength(2)
})

test("unknown teardown writer blocks return, and recovery never replays its failed sequence", async () => {
  const h = await harness()
  h.state.failPress = true
  const cleanupRuntime = h.runtime()
  const cleanup = () =>
    createOtaCustomerStep(
      {
        ...cleanupRuntime,
        prepare: async (context) => {
          h.state.page = "home"
          return cleanupRuntime.prepare(context)
        },
        recordFailure: async () => {
          h.state.idle = "unknown"
        },
      },
      {id: "restore-selected-components", phase: "teardown"},
    )
  h.options.routine.teardown.push(cleanup())
  expect(await runLifecycle(h.options)).toMatchObject({test: "failed", fixture: "recovery-required"})
  const count = h.calls.filter((call) => call === "button-Update Now").length
  expect(count).toBe(2)
  h.options.routine.teardown[1] = cleanup()
  expect(await recoverLifecycle(h.options)).toMatchObject({test: "failed", fixture: "recovery-required"})
  h.state.idle = "settled"
  expect(await recoverLifecycle(h.options)).toMatchObject({test: "failed", fixture: "recovery-required"})
  expect(h.calls.filter((call) => call === "button-Update Now")).toHaveLength(count)
  const operations = (await journal(h.folder)).at(-1)!.state.operations
  expect(operations.find((op) => op.stepID === "restore-selected-components")?.dispatch).toMatchObject({
    failed: true,
    progress: {finished: false},
  })
})

test("a true process exit after the update press never replays and cannot manufacture completed progress", async () => {
  const h = await harness()
  const source = `
    import {writeFile} from "node:fs/promises";
    import {runLifecycle} from ${JSON.stringify(new URL("./lifecycle.ts", import.meta.url).href)};
    import {createOtaCustomerStep} from ${JSON.stringify(new URL("./ota-customer-step.ts", import.meta.url).href)};
    const proof=${proof.toString()},screen=${screen.toString()};
    let page="home";
    const selection=${JSON.stringify(selection)};
    const actions={snapshot:async()=>screen(page),hardware:async()=>(${JSON.stringify(initialHardware)}),
      readBesVersion:async()=>"",observe:async()=>{},verifyAppPair:async()=>{},verifyTarget:async()=>{},observeHardware:async()=>{},
      executeStep:async()=>{page="available";return true},
      press:async identifier=>{await writeFile(${JSON.stringify(join(h.folder, "dispatched.json"))},JSON.stringify({identifier}));process.exit(73)}};
    const assertion=id=>({id,kind:"assertion",instruction:"Read independent evidence.",observe:async()=>({...proof(id),passed:true})});
    const customer=createOtaCustomerStep({prepare:async()=>({...proof("prepared"),passed:true}),
      recording:async()=>({selection,actions,metadata:{}}),idle:async()=>({...proof("busy"),status:"active"}),
      verifyTarget:async()=>({...proof("unverified"),passed:false}),clock:{now:()=>0,sleep:async()=>{}}});
    await runLifecycle({runDirectory:${JSON.stringify(h.options.runDirectory)},fixtureDirectory:${JSON.stringify(h.options.fixtureDirectory)},
      selection:${JSON.stringify(h.options.selection)},acquireLease:async()=>async()=>{},routine:{
        id:"day1-test",definitionDigest:"frozen-definition",preflight:[assertion("preflight")],setup:[],test:[customer],
        finalAssertions:[assertion("final")],teardown:[],returnVerification:[assertion("return")],evidence:[assertion("evidence")]}});
  `
  const child = Bun.spawn([process.execPath, "--eval", source], {stdout: "pipe", stderr: "pipe"})
  expect({code: await child.exited, stderr: await new Response(child.stderr).text()}).toEqual({code: 73, stderr: ""})
  expect(JSON.parse(await readFile(join(h.folder, "dispatched.json"), "utf8"))).toEqual({
    identifier: "button-Update Now",
  })
  expect((await journal(h.folder)).at(-1)?.type).toBe("mutation-intent")
  h.state.idle = "active"
  expect(await recoverLifecycle(h.options)).toMatchObject({
    test: "failed",
    fixture: "recovery-required",
    teardown: "deferred",
  })
  h.state.idle = "settled"
  expect(await recoverLifecycle(h.options)).toMatchObject({test: "failed", fixture: "ready", teardown: "passed"})
  expect(h.calls).not.toContain("recording")
  expect(h.calls).not.toContain("button-Update Now")
  expect(h.calls).not.toContain("independent-target")
  const operation = (await journal(h.folder)).at(-1)!.state.operations[0]
  expect(operation.dispatch).toBeUndefined()
  expect(operation.reconciliation?.status).toBe("settled")
}, 10000)
