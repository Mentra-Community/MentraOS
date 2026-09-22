import {expect, test} from "bun:test"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {
  createDay1FullOtaSteps,
  type Day1FullOtaInputs,
  type Day1FullOtaInvocation,
  type Day1FullOtaRuntime,
} from "./day1-full-ota"
import {
  recoverLifecycle,
  runLifecycle,
  type AssertionStep,
  type LifecycleContext,
  type LifecycleEvent,
  type LifecycleOptions,
  type LifecycleRoutine,
  type MutationIntent,
} from "./lifecycle"

const owner = "bd80e7eb-0456-4098-afc6-0567b1c4a27a"
const inputs: Day1FullOtaInputs = {
  config: {path: "/private/test config/frozen.json", sha256: "a".repeat(64)},
  python: "/private/test runtime/bin/python",
  adapterDirectory: "/private/trusted adapter",
}

async function temporary(body: (folder: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "mentra-day1-factory-"))
  try {
    await body(folder)
  } finally {
    await rm(folder, {recursive: true, force: true})
  }
}

function harness(
  folder: string,
  options: {stageFails?: boolean; wrongOwner?: boolean; stale?: boolean; invalidResult?: boolean} = {},
) {
  let held = false
  let leases = 0
  let originalOwner: string | null = null
  let device: "source" | "staged" | "january" | "active" = "source"
  const commands: Day1FullOtaInvocation[] = []
  const reads: string[] = []
  const runtime: Day1FullOtaRuntime = {
    async readCurrentState(context) {
      expect(held).toBe(true)
      reads.push(context.phase)
      const now = Date.now() / 1000 - (options.stale ? 60 : 0)
      return {
        current: {
          startedAt: now,
          finishedAt: now,
          bootBefore: "synthetic-boot",
          bootAfter: "synthetic-boot",
          identity: {boot: "synthetic-boot"},
          engineStatus: "UPDATE_STATUS_IDLE",
        },
        evidence: [join(context.lifecycle.runDirectory, `observation-${reads.length}.json`)],
      }
    },
    async invoke(command) {
      expect(held).toBe(true)
      commands.push(structuredClone(command))
      const evidence = [join(command.lifecycle.runDirectory, `command-${commands.length}.json`)]
      if (command.kind === "mutation") {
        const rows = (await readFile(join(command.lifecycle.runDirectory, "events.jsonl"), "utf8")).trim().split("\n")
        const last = JSON.parse(rows.at(-1)!) as LifecycleEvent
        expect(last.type).toBe("mutation-intent")
        expect((last.details as {operationID: string}).operationID).toBe(command.lifecycleOperationID!)
        expect(command.argv[0]).toBe(inputs.python)
        expect(command.argv[1]).toBe(join(inputs.adapterDirectory, "full_january.py"))
        expect(command.stdin).toBeUndefined()
        if (command.phase === "stage") {
          originalOwner = command.stageOwner
          expect(command.argv.slice(-2)).toEqual(["--owner", command.lifecycleOperationID!])
          expect(originalOwner).toBe(command.lifecycleOperationID!)
          device = options.stageFails ? "active" : "staged"
        } else {
          expect(device).toBe("staged")
          expect(command.stageOwner).toBe(originalOwner)
          expect(command.lifecycleOperationID).not.toBe(originalOwner)
          expect(command.argv).not.toContain("--owner")
          device = "january"
        }
        return {exitCode: options.stageFails ? 7 : 0, stdout: "private adapter command output", evidence}
      }
      expect(command.argv[1]).toBe("-c")
      expect(command.argv[2]).toContain("json.load(sys.stdin)")
      expect(command.argv.slice(-2)).toEqual([command.phase, command.adapterRunDirectory])
      expect(JSON.parse(command.stdin!).bootAfter).toBe("synthetic-boot")
      if (options.invalidResult) return {exitCode: 0, stdout: '{"status":"satisfied"}', evidence}
      const status =
        device === "active"
          ? "active"
          : command.phase === "stage"
            ? device === "source"
              ? "settled"
              : "satisfied"
            : device === "staged"
              ? "settled"
              : "satisfied"
      return {
        exitCode: 0,
        evidence,
        stdout: JSON.stringify({
          status,
          reason: "synthetic_test_observation",
          owner: options.wrongOwner ? owner : originalOwner,
          evidence: originalOwner ? [join(command.adapterRunDirectory, "operation.json")] : [],
          setupOnly: true,
          fixtureReadyForOtherRoutines: false,
        }),
      }
    },
  }
  const steps = createDay1FullOtaSteps(inputs, runtime)
  const assertion = (id: string, passed: boolean): AssertionStep => ({
    kind: "assertion",
    id,
    instruction: `Synthetic ${id} test assertion.`,
    observe: async () => ({
      passed,
      observedAt: new Date().toISOString(),
      expected: passed,
      actual: passed,
      source: "fake-only test harness",
      evidence: [join(folder, `${id}.json`)],
    }),
  })
  const routine: LifecycleRoutine = {
    id: "synthetic-day1-composition",
    definitionDigest: "synthetic-definition",
    preflight: [assertion("preflight", true)],
    setup: steps,
    test: [],
    finalAssertions: [assertion("customer-not-qualified", false)],
    teardown: [],
    returnVerification: [assertion("return-not-qualified", false)],
    evidence: [assertion("evidence", true)],
  }
  let retainedLease: Parameters<LifecycleOptions["acquireLease"]>[0] | undefined
  const lifecycle: LifecycleOptions = {
    runDirectory: join(folder, "run"),
    fixtureDirectory: join(folder, "fixture"),
    routine,
    selection: {
      runID: "test-run",
      fixtureID: "synthetic-fixture",
      returnProfileDigest: "test-return-profile",
      inputs: {setupConfigSha256: inputs.config.sha256},
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
    commands,
    reads,
    steps,
    runtime,
    lifecycle,
    get leases() {
      return leases
    },
  }
}

const mutations = (commands: Day1FullOtaInvocation[]) => commands.filter((value) => value.kind === "mutation")

async function state(path: string) {
  return JSON.parse(await readFile(join(path, "state.json"), "utf8")) as {operations: MutationIntent[]}
}

test("two setup steps execute under one existing lease and preserve the stage owner/run for activation", async () => {
  await temporary(async (folder) => {
    const h = harness(folder)
    const result = await runLifecycle(h.lifecycle)
    expect(h.leases).toBe(1)
    const calls = mutations(h.commands)
    expect(calls.map((call) => call.phase)).toEqual(["stage", "activate"])
    expect(calls[0].adapterRunDirectory).toBe(join(h.lifecycle.runDirectory, "day1-full-ota"))
    expect(calls[1].adapterRunDirectory).toBe(calls[0].adapterRunDirectory)
    expect(calls[1].stageOwner).toBe(calls[0].stageOwner)
    for (const call of calls) {
      expect(call.argv.slice(3, 7)).toEqual(["--config", inputs.config.path, "--config-sha256", inputs.config.sha256])
      expect(call.argv.slice(7, 9)).toEqual(["--run", calls[0].adapterRunDirectory])
    }
    expect(h.reads).toEqual(["stage", "stage", "activate", "activate"])
    expect(result.fixture).toBe("recovery-required") // setup never fabricates selected-modern return proof
    const operations = (await state(h.lifecycle.runDirectory)).operations
    expect(operations).toHaveLength(2)
    expect(operations[0].reconciliation?.status).toBe("satisfied")
    expect(operations[1].reconciliation?.actual).toMatchObject({
      stageOwner: operations[0].operationID,
      setupOnly: true,
      fixtureReadyForOtherRoutines: false,
    })
    expect(JSON.stringify(operations)).not.toContain("private adapter command output")
  })
})

test("a failed active stage retains command failure and recovery never resends or activates", async () => {
  await temporary(async (folder) => {
    const h = harness(folder, {stageFails: true})
    const result = await runLifecycle(h.lifecycle)
    expect(result.test).toBe("not-run")
    expect(result.fixture).toBe("recovery-required")
    expect(mutations(h.commands).map((call) => call.phase)).toEqual(["stage"])
    const operation = (await state(h.lifecycle.runDirectory)).operations[0]
    expect(operation.dispatch).toMatchObject({exitCode: 7})
    expect(operation.reconciliation?.status).toBe("active")
    const count = h.commands.length
    await recoverLifecycle(h.lifecycle)
    expect(h.commands.length).toBeGreaterThan(count)
    expect(mutations(h.commands)).toHaveLength(1)
    expect(h.leases).toBe(2) // one lease per lifecycle call; none inside either adapter step
  })
})

test("a different run's receipt owner never allows a fresh dispatch", async () => {
  await temporary(async (folder) => {
    const h = harness(folder, {wrongOwner: true})
    const result = await runLifecycle(h.lifecycle)
    expect(result.test).toBe("not-run")
    expect(mutations(h.commands)).toHaveLength(0)
  })
})

test("missing live reads and invalid scoped reconciliation cannot become success", async () => {
  for (const invalid of [{stale: true}, {invalidResult: true}]) {
    await temporary(async (folder) => {
      const h = harness(folder, invalid)
      const result = await runLifecycle(h.lifecycle)
      expect(result.fixture).toBe("recovery-required")
      expect(result.test).toBe("not-run")
      expect(mutations(h.commands)).toHaveLength(0)
      if ("stale" in invalid) expect(h.commands).toHaveLength(0)
    })
  }
})

test("activation without an owning stage and execution without durable intent do not invoke callbacks", async () => {
  const invoked: string[] = []
  const [stage, activate] = createDay1FullOtaSteps(inputs, {
    readCurrentState: async () => {
      invoked.push("read")
      throw new Error("unexpected")
    },
    invoke: async () => {
      invoked.push("invoke")
      throw new Error("unexpected")
    },
  })
  const context: LifecycleContext = {
    runDirectory: "/private/test run",
    selection: {runID: "run", fixtureID: "fixture", returnProfileDigest: "return", inputs: {}},
    operations: [],
  }
  await expect(activate.reconcile(context)).rejects.toThrow("no owning stage")
  await expect(
    stage.execute(context, {operationID: owner, stepID: stage.id, phase: "setup", startedAt: new Date().toISOString()}),
  ).rejects.toThrow("durable lifecycle intent")
  expect(invoked).toEqual([])
})

test("activation rejects a changed run directory or stage config binding before any new command", async () => {
  await temporary(async (folder) => {
    const h = harness(folder)
    await runLifecycle(h.lifecycle)
    const operations = (await state(h.lifecycle.runDirectory)).operations
    const intent = operations[1]
    const context: LifecycleContext = {
      runDirectory: h.lifecycle.runDirectory,
      selection: h.lifecycle.selection,
      operations,
    }
    const count = h.commands.length
    await expect(h.steps[1].execute({...context, runDirectory: join(folder, "another-run")}, intent)).rejects.toThrow(
      "successful live reconciliation",
    )
    const changed = structuredClone(context)
    ;(changed.operations[0].reconciliation!.actual as {[key: string]: unknown}).configSha256 = "b".repeat(64)
    await expect(h.steps[1].execute(changed, intent)).rejects.toThrow("successful live reconciliation")
    expect(h.commands.length).toBe(count)
  })
})

test("construction validates explicit paths/hash and freezes inputs without I/O", async () => {
  const mutable = structuredClone(inputs)
  const calls: Day1FullOtaInvocation[] = []
  const [stage] = createDay1FullOtaSteps(mutable, {
    readCurrentState: async () => {
      throw new Error("unexpected")
    },
    invoke: async (command) => {
      calls.push(command)
      return {exitCode: 1, stdout: "", evidence: ["owned-command.json"]}
    },
  })
  mutable.config.path = "/private/changed.json"
  mutable.config.sha256 = "b".repeat(64)
  const intent: MutationIntent = {
    operationID: owner,
    stepID: stage.id,
    phase: "setup",
    startedAt: new Date().toISOString(),
  }
  await stage.execute(
    {
      runDirectory: "/private/own run",
      selection: {runID: "run", fixtureID: "fixture", returnProfileDigest: "return", inputs: {}},
      operations: [intent],
    },
    intent,
  )
  expect(calls[0].argv).toContain(inputs.config.path)
  expect(calls[0].argv).toContain(inputs.config.sha256)
  expect(calls[0].argv).not.toContain(mutable.config.path)
  expect(() => createDay1FullOtaSteps({...inputs, python: "python3"}, {} as Day1FullOtaRuntime)).toThrow("absolute")
  expect(() =>
    createDay1FullOtaSteps({...inputs, config: {...inputs.config, sha256: "latest"}}, {} as Day1FullOtaRuntime),
  ).toThrow("SHA-256")
  expect(() =>
    createDay1FullOtaSteps({...inputs, adapterDirectory: "/private/a/../b"}, {} as Day1FullOtaRuntime),
  ).toThrow("normalized")
})

test("fixed read-only bridge runs the canonical Python validator with offline synthetic inputs", async () => {
  await temporary(async (folder) => {
    const adapterDirectory = join(import.meta.dir, "../adapters/day1-setup")
    const run = async (argv: string[], stdin = "") => {
      const child = Bun.spawn(argv, {stdin: "pipe", stdout: "pipe", stderr: "pipe"})
      child.stdin.write(stdin)
      child.stdin.end()
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (exitCode !== 0) throw new Error(`Offline Python bridge failed: ${stderr}`)
      return {stdout, exitCode}
    }
    const created = await run([
      "python3",
      "-c",
      `import json, sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from test_support import make_config
cfg=make_config(Path(sys.argv[2])/'configuration')
print(json.dumps({'python':sys.executable,'path':str(cfg.path),'sha256':cfg.sha256}))
`,
      adapterDirectory,
      folder,
    ])
    const config = JSON.parse(created.stdout)
    const invocations: Day1FullOtaInvocation[] = []
    const [stage] = createDay1FullOtaSteps(
      {python: config.python, config: {path: config.path, sha256: config.sha256}, adapterDirectory},
      {
        async readCurrentState() {
          const now = Date.now() / 1000
          const boot = "1ae86177-4bba-4fb0-9e80-0494e0b867ca"
          return {
            current: {
              startedAt: now,
              finishedAt: now,
              bootBefore: boot,
              bootAfter: boot,
              engineStatus: "UPDATE_STATUS_IDLE",
              identity: {
                boot,
                cid: "0123456789abcdef0123456789abcdef",
                serial: "TEST012345",
                bootSerial: "TEST012345",
                mac: "AA:BB:CC:DD:EE:01",
                mtk: "MentraLive_20260921.0",
                epoch: "1790034149",
                slot: "_a",
                uid: "2000",
                bootCompleted: "1",
              },
            },
            evidence: [join(folder, "synthetic-observation.json")],
          }
        },
        async invoke(command) {
          expect(command.kind).toBe("reconciliation")
          invocations.push(command)
          return {...(await run(command.argv, command.stdin)), evidence: [join(folder, "synthetic-command.json")]}
        },
      },
    )
    const result = await stage.reconcile({
      runDirectory: join(folder, "new-lifecycle"),
      operations: [],
      selection: {
        runID: "offline-only",
        fixtureID: "synthetic-fixture",
        returnProfileDigest: "unqualified",
        inputs: {},
      },
    })
    expect(result.status).toBe("settled")
    expect(result.actual).toMatchObject({
      setupOnly: true,
      fixtureReadyForOtherRoutines: false,
      reason: "exact_source_idle_before_first_dispatch",
    })
    expect(invocations).toHaveLength(1)
  })
})
