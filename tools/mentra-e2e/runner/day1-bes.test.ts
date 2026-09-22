import {expect, test} from "bun:test"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {
  createDay1BesStep,
  type Day1BesCurrentState,
  type Day1BesInputs,
  type Day1BesInvocation,
  type Day1BesRuntime,
} from "./day1-bes"
import {
  recoverLifecycle,
  runLifecycle,
  type AssertionStep,
  type LifecycleContext,
  type LifecycleOptions,
  type MutationIntent,
} from "./lifecycle"

const sourceBoot = "eb8b8b3b-d15e-4993-a0af-7f6e4ef60d0f"
const targetBoot = "ec7b7241-b958-4425-b7a6-a21ca1b17de0"
const foreignOwner = "bd80e7eb-0456-4098-afc6-0567b1c4a27a"
const nativeOwner = "adb-bes-" + "a".repeat(32)
const inputs: Day1BesInputs = {
  config: {path: "/private/synthetic frozen/bes.json", sha256: "a".repeat(64)},
  python: "/private/synthetic runtime/python",
  adapterDirectory: "/private/synthetic adapter",
}

async function temporary(body: (folder: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "mentra-bes-step-"))
  try {
    await body(folder)
  } finally {
    await rm(folder, {recursive: true, force: true})
  }
}

function harness(
  folder: string,
  options: {active?: boolean; stale?: boolean; foreign?: boolean; noContinuity?: boolean} = {},
) {
  let held = false,
    leases = 0
  let device: "source" | "active" | "target" = "source"
  const commands: Day1BesInvocation[] = []
  const observations: string[] = []
  const runtime: Day1BesRuntime = {
    async readCurrentState(bound) {
      expect(held).toBe(true)
      observations.push(bound.observationOwner)
      const now = Date.now() / 1000 - (options.stale ? 60 : 0)
      const boot = device === "target" ? targetBoot : sourceBoot
      return {
        current: {
          schemaVersion: 1,
          firmwareWrites: 0,
          observationOwner: bound.observationOwner,
          startedAt: now,
          finishedAt: now,
          bootBefore: boot,
          bootAfter: boot,
          pidBefore: "123",
          pidAfter: "123",
          startTicksBefore: "100",
          startTicksAfter: "100",
          endpoint: "192.168.50.20:5555",
          observed: {boot_id: boot},
          logCapturedAt: now,
          log: {path: join(folder, "observation.log"), sha256: "b".repeat(64)},
        },
        evidence: [join(folder, "observation.json")],
      }
    },
    async invoke(command) {
      expect(held).toBe(true)
      commands.push(structuredClone(command))
      const evidence = [join(folder, `command-${commands.length}.json`)]
      if (command.kind === "mutation") {
        const rows = (await readFile(join(command.lifecycle.runDirectory, "events.jsonl"), "utf8")).trim().split("\n")
        const last = JSON.parse(rows.at(-1)!)
        expect(last.type).toBe("mutation-intent")
        expect(last.details.operationID).toBe(command.lifecycleOwner)
        expect(command.lifecycleOwner).toBe(command.observationOwner)
        expect(command.argv).toEqual([
          inputs.python,
          join(inputs.adapterDirectory, "run.py"),
          "install",
          "--config",
          inputs.config.path,
          "--config-sha256",
          inputs.config.sha256,
          "--owner",
          command.lifecycleOwner!,
          "--run",
          command.adapterRunDirectory,
        ])
        expect(command.stdin).toBeUndefined()
        device = options.active ? "active" : "target"
        return {exitCode: options.active ? 7 : 0, stdout: "Private adapter output", evidence}
      }
      expect(command.argv[1]).toBe("-c")
      expect(command.argv[2]).toContain("cfg.require_lease()")
      expect(command.argv.slice(-2)).toEqual([command.adapterRunDirectory, command.observationOwner])
      const current = JSON.parse(command.stdin!) as Day1BesCurrentState
      const status = device === "source" ? "settled" : device === "active" ? "active" : "satisfied"
      return {
        exitCode: 0,
        evidence,
        stdout: JSON.stringify({
          status,
          reason: "synthetic_native_observation",
          lifecycleOwner: options.foreign ? foreignOwner : command.observationOwner,
          nativeOwner: device === "source" ? null : nativeOwner,
          setupOnly: true,
          fixtureReadyForOtherRoutines: false,
          evidence: [],
          ...(status === "satisfied" && !options.noContinuity
            ? {
                continuityInput: {
                  schemaVersion: 1,
                  kind: "verified-install-continuity",
                  sourceBoot: current.bootAfter,
                  besOwner: nativeOwner,
                  installIntent: {
                    path: join(command.adapterRunDirectory, "dispatch/install-intent.json"),
                    sha256: "c".repeat(64),
                  },
                  installLog: {path: join(command.adapterRunDirectory, "handshake.log"), sha256: "d".repeat(64)},
                  versionLog: current.log,
                },
              }
            : {}),
        }),
      }
    },
  }
  const assertion = (id: string, passed: boolean): AssertionStep => ({
    id,
    kind: "assertion",
    instruction: id,
    observe: async () => ({
      passed,
      expected: passed,
      actual: passed,
      observedAt: new Date().toISOString(),
      source: "synthetic test",
      evidence: [join(folder, `${id}.json`)],
    }),
  })
  const step = createDay1BesStep(inputs, runtime)
  let retainedLease: Parameters<LifecycleOptions["acquireLease"]>[0] | undefined
  const lifecycle: LifecycleOptions = {
    runDirectory: join(folder, "run"),
    fixtureDirectory: join(folder, "fixture"),
    selection: {runID: "synthetic-run", fixtureID: "synthetic-fixture", returnProfileDigest: "unqualified", inputs: {}},
    routine: {
      id: "synthetic-bes-composition",
      definitionDigest: "test-definition",
      preflight: [assertion("preflight", true)],
      setup: [step],
      test: [],
      finalAssertions: [assertion("customer-not-qualified", false)],
      teardown: [],
      returnVerification: [assertion("return-not-qualified", false)],
      evidence: [assertion("evidence", true)],
    },
    acquireLease: async (owner) => {
      if (retainedLease) expect(owner).toEqual(retainedLease)
      else expect(held).toBe(false)
      retainedLease = undefined
      held = true
      leases++
      return async () => {
        held = false
      }
    },
    onLeaseRetained: async (owner) => {
      retainedLease = {recovering: true, runDirectory: owner.runDirectory, selection: owner.selection}
    },
  }
  return {
    step,
    runtime,
    lifecycle,
    commands,
    observations,
    get leases() {
      return leases
    },
  }
}

const mutations = (calls: Day1BesInvocation[]) => calls.filter((call) => call.kind === "mutation")
async function operations(folder: string): Promise<MutationIntent[]> {
  return JSON.parse(await readFile(join(folder, "state.json"), "utf8")).operations
}

test("one leased BES install uses durable lifecycle UUID and returns only native setup continuity", async () => {
  await temporary(async (folder) => {
    const h = harness(folder),
      result = await runLifecycle(h.lifecycle)
    expect(h.leases).toBe(1)
    expect(mutations(h.commands)).toHaveLength(1)
    const intent = (await operations(h.lifecycle.runDirectory))[0]
    expect(h.observations[0]).not.toBe(intent.operationID)
    expect(h.observations[1]).toBe(intent.operationID)
    expect(intent.reconciliation?.status).toBe("satisfied")
    expect(intent.reconciliation?.actual).toMatchObject({
      lifecycleOwner: intent.operationID,
      continuityInput: {sourceBoot: targetBoot, besOwner: nativeOwner},
      setupOnly: true,
      fixtureReadyForOtherRoutines: false,
    })
    expect(JSON.stringify(intent)).not.toContain("Private adapter output")
    expect(result.fixture).toBe("recovery-required")
  })
})

test("active failed command survives recovery under a fresh factory without another install", async () => {
  await temporary(async (folder) => {
    const h = harness(folder, {active: true}),
      first = await runLifecycle(h.lifecycle)
    const original = (await operations(h.lifecycle.runDirectory))[0]
    expect(original.dispatch).toMatchObject({exitCode: 7})
    expect(original.reconciliation?.status).toBe("active")
    expect(first.test).toBe("not-run")
    h.lifecycle.routine.setup = [createDay1BesStep(inputs, h.runtime)]
    await recoverLifecycle(h.lifecycle)
    expect(mutations(h.commands)).toHaveLength(1)
    expect(h.observations.at(-1)).toBe(original.operationID)
    expect((await operations(h.lifecycle.runDirectory))[0].dispatch).toEqual(original.dispatch)
    expect(h.leases).toBe(2)
  })
})

test("stale reads or foreign native receipt cannot authorize the first install", async () => {
  for (const options of [{stale: true}, {foreign: true}])
    await temporary(async (folder) => {
      const h = harness(folder, options),
        result = await runLifecycle(h.lifecycle)
      expect(mutations(h.commands)).toHaveLength(0)
      expect(result.test).toBe("not-run")
      expect(result.fixture).toBe("recovery-required")
    })
})

test("exit zero without native continuity stays unqualified and recovery never resends", async () => {
  await temporary(async (folder) => {
    const h = harness(folder, {noContinuity: true}),
      result = await runLifecycle(h.lifecycle)
    expect(mutations(h.commands)).toHaveLength(1)
    expect(result.test).toBe("not-run")
    expect((await operations(h.lifecycle.runDirectory))[0].reconciliation?.status).not.toBe("satisfied")
    await recoverLifecycle(h.lifecycle)
    expect(mutations(h.commands)).toHaveLength(1)
  })
})

test("pre-intent observation ID is stable and a nonmatching intent never invokes runtime", async () => {
  const calls: string[] = []
  const runtime: Day1BesRuntime = {
    readCurrentState: async (bound) => {
      calls.push(bound.observationOwner)
      throw new Error("read-only test")
    },
    invoke: async () => {
      throw new Error("unexpected command")
    },
  }
  const step = createDay1BesStep(inputs, runtime)
  const context: LifecycleContext = {
    runDirectory: "/private/synthetic run",
    operations: [],
    selection: {runID: "test", fixtureID: "fixture", returnProfileDigest: "unqualified", inputs: {}},
  }
  await expect(step.reconcile(context)).rejects.toThrow("read-only test")
  await expect(step.reconcile(context)).rejects.toThrow("read-only test")
  expect(calls[0]).toBe(calls[1])
  const intent: MutationIntent = {
    operationID: foreignOwner,
    stepID: step.id,
    phase: "setup",
    startedAt: new Date().toISOString(),
  }
  await expect(step.execute(context, intent)).rejects.toThrow("durable setup intent")
  await expect(step.reconcile({...context, operations: [intent]})).rejects.toThrow("durable setup intent")
  expect(calls).toHaveLength(2)
})

test("factory freezes normalized input pins without I/O", async () => {
  const selected = structuredClone(inputs),
    calls: Day1BesInvocation[] = []
  const step = createDay1BesStep(selected, {
    readCurrentState: async () => {
      throw new Error("unexpected")
    },
    invoke: async (call) => {
      calls.push(call)
      return {exitCode: 1, stdout: "", evidence: ["/private/synthetic-command.json"]}
    },
  })
  selected.config.path = "/private/changed.json"
  const intent: MutationIntent = {
    operationID: foreignOwner,
    stepID: step.id,
    phase: "setup",
    startedAt: new Date().toISOString(),
  }
  await step.execute(
    {
      runDirectory: "/private/synthetic run",
      operations: [intent],
      selection: {runID: "test", fixtureID: "fixture", returnProfileDigest: "unqualified", inputs: {}},
    },
    intent,
  )
  expect(calls[0].argv).toContain(inputs.config.path)
  expect(() => createDay1BesStep({...inputs, python: "python3"}, {} as Day1BesRuntime)).toThrow("absolute")
  expect(() =>
    createDay1BesStep({...inputs, config: {...inputs.config, sha256: "latest"}}, {} as Day1BesRuntime),
  ).toThrow("SHA-256")
})
