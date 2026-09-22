import {expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {
  recoverLifecycle,
  runLifecycle,
  type AssertionStep,
  type FixtureRecord,
  type LifecycleEvent,
  type LifecycleLeaseOwner,
  type LifecycleOptions,
  type LifecycleRoutine,
  type LifecycleTerminalSnapshot,
  type MutationStep,
  type Observation,
  type RetainedLifecycleLease,
} from "./lifecycle"

function proof(actual: string, expected: string): Observation {
  return {
    actual,
    expected,
    observedAt: new Date().toISOString(),
    source: "simulated-device",
    evidence: ["hardware/fresh-observation.json"],
    identity: {physical: "fixture-one", boot: "boot-one"},
  }
}

async function fixture(run: (folder: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "mentra-lifecycle-"))
  try {
    await run(folder)
  } finally {
    await rm(folder, {recursive: true, force: true})
  }
}

function harness(folder: string) {
  const device = {version: "target", active: false}
  const dispatched: string[] = []
  const reconciled: string[] = []
  let held = false
  let releases = 0
  let retainedOwner: LifecycleLeaseOwner | undefined
  const retained: RetainedLifecycleLease[] = []
  const assertion = (id: string, expected = "target"): AssertionStep => ({
    kind: "assertion",
    id,
    instruction: `Verify ${id}.`,
    observe: async () => ({...proof(device.version, expected), passed: device.version === expected && !device.active}),
  })
  const mutation = (id: string, target: string): MutationStep => ({
    kind: "mutation",
    id,
    instruction: `Install ${target}.`,
    repeat: "never",
    execute: async (_context, intent) => {
      // An adapter can verify that the durable intent exists before issuing a command.
      const lines = await readFile(join(folder, "run", "events.jsonl"), "utf8")
      expect(lines).toContain(intent.operationID)
      expect(JSON.parse(lines.trim().split("\n").at(-1)!).type).toBe("mutation-intent")
      dispatched.push(id)
      device.version = target
      return {accepted: true, operationID: intent.operationID}
    },
    reconcile: async () => {
      reconciled.push(id)
      return {
        ...proof(device.version, target),
        status: device.active ? "active" : device.version === target ? "satisfied" : "settled",
      }
    },
  })
  const routine: LifecycleRoutine = {
    id: "simulated-ota",
    definitionDigest: "frozen-definition",
    preflight: [assertion("identity-power-recovery")],
    setup: [mutation("baseline", "baseline")],
    test: [mutation("upgrade", "target")],
    finalAssertions: [assertion("final-versions")],
    teardown: [mutation("restore", "target")],
    returnVerification: [assertion("return-versions-and-idle")],
    evidence: [{...assertion("recordings"), observe: async () => ({...proof("complete", "complete"), passed: true})}],
  }
  const options: LifecycleOptions = {
    runDirectory: join(folder, "run"),
    fixtureDirectory: join(folder, "fixture"),
    selection: {
      runID: "run-one",
      fixtureID: "fixture-one",
      returnProfileDigest: "target-manifest-digest",
      inputs: {build: "candidate"},
    },
    routine,
    acquireLease: async (owner) => {
      if (held) throw new Error("Resource lease is held")
      if (
        retainedOwner &&
        (!owner.recovering ||
          owner.runDirectory !== retainedOwner.runDirectory ||
          JSON.stringify(owner.selection) !== JSON.stringify(retainedOwner.selection))
      )
        throw new Error("Resource lease is retained for its owning recovery")
      held = true
      return async () => {
        held = false
        retainedOwner = undefined
        releases++
      }
    },
    onLeaseRetained: async (owner) => {
      retained.push(owner)
      retainedOwner = owner
      held = false
    },
  }
  return {
    options,
    routine,
    device,
    dispatched,
    reconciled,
    retained,
    mutation,
    assertion,
    get releases() {
      return releases
    },
  }
}

async function events(folder: string): Promise<LifecycleEvent[]> {
  return (await readFile(join(folder, "run", "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

async function fixtureRecord(folder: string): Promise<FixtureRecord> {
  return JSON.parse(await readFile(join(folder, "fixture", "fixture.json"), "utf8"))
}

test("successful setup/test freezes its result before teardown, skips an already-correct return state", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    const result = await runLifecycle(h.options)
    expect(result).toMatchObject({
      test: "passed",
      teardown: "passed",
      evidence: "passed",
      fixture: "ready",
      outcome: "passed",
    })
    expect(h.dispatched).toEqual(["baseline", "upgrade"])
    expect(h.releases).toBe(1)
    const journal = await events(folder)
    expect(journal.findIndex((event) => event.type === "test-frozen")).toBeLessThan(
      journal.findIndex((event) => event.phase === "teardown"),
    )
    expect(journal.map((event) => event.sequence)).toEqual(journal.map((_, index) => index + 1))
    expect(await fixtureRecord(folder)).toMatchObject({
      status: "ready",
      returnProfileDigest: "target-manifest-digest",
      lastVerification: {runDirectory: h.options.runDirectory},
    })
  })
})

test("partial setup failure restores recorded changes without running the customer test", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    const failed = h.mutation("second-setup", "other")
    failed.execute = async () => {
      throw new Error("Installer failed before changing the second component")
    }
    h.routine.setup.push(failed)
    const restore = h.routine.teardown[0] as MutationStep
    const execute = restore.execute
    restore.execute = async (context, intent) => {
      expect(context.operations.map((operation) => operation.stepID)).toEqual(["baseline", "second-setup", "restore"])
      return execute(context, intent)
    }
    const result = await runLifecycle(h.options)
    expect(result).toMatchObject({test: "not-run", teardown: "passed", fixture: "ready", outcome: "setup-failed"})
    expect(h.dispatched).toEqual(["baseline", "restore"])
    expect(h.device.version).toBe("target")
  })
})

test("failed customer assertion remains failed after successful restoration", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    h.routine.test = [h.assertion("customer-upgrade", "unreachable-version")]
    const result = await runLifecycle(h.options)
    expect(result).toMatchObject({test: "failed", teardown: "passed", fixture: "ready", outcome: "failed"})
    expect(h.dispatched).toEqual(["baseline", "restore"])
    expect(h.releases).toBe(1)
    expect(h.retained).toEqual([])
  })
})

test("failed restoration keeps the fixture unavailable after its process lease is released", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    h.routine.test = [h.assertion("customer-upgrade", "unreachable-version")]
    const restore = h.routine.teardown[0] as MutationStep
    restore.execute = async () => {
      throw new Error("Restoration unavailable")
    }
    const result = await runLifecycle(h.options)
    expect(result).toMatchObject({
      test: "failed",
      teardown: "failed",
      returnVerification: "failed",
      fixture: "recovery-required",
    })
    expect(h.releases).toBe(1)
    await expect(
      runLifecycle({
        ...h.options,
        runDirectory: join(folder, "next"),
        selection: {...h.options.selection, runID: "run-two"},
      }),
    ).rejects.toThrow("recovery-required")
    const recovered = await recoverLifecycle(h.options)
    expect(recovered.fixture).toBe("recovery-required")
    expect(recovered.teardown).toBe("deferred")
    expect(h.dispatched).toEqual(["baseline"])
    // A qualified external recovery may establish the return state; fresh proof can then clear the gate.
    h.device.version = "target"
    expect((await recoverLifecycle(h.options)).fixture).toBe("ready")
  })
})

test("evidence failure makes a passing run incomplete without making verified hardware unavailable", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    h.routine.evidence[0].observe = async () => ({...proof("missing video", "complete recording"), passed: false})
    expect(await runLifecycle(h.options)).toMatchObject({
      test: "passed",
      evidence: "failed",
      fixture: "ready",
      outcome: "incomplete",
    })
  })
})

test("cancellation waits for the dispatched operation and then restores without forwarding the abort", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    const controller = new AbortController()
    h.options.signal = controller.signal
    const setup = h.routine.setup[0] as MutationStep
    const execute = setup.execute
    setup.execute = async (context, intent) => {
      controller.abort()
      await Promise.resolve()
      return execute(context, intent)
    }
    expect(await runLifecycle(h.options)).toMatchObject({
      test: "cancelled",
      teardown: "passed",
      fixture: "ready",
      outcome: "cancelled",
    })
    expect(h.dispatched).toEqual(["baseline", "restore"])
  })
})

test("operator stop defers restoration instead of forcing another firmware write", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    let allowed = true
    h.options.mutationsAllowed = () => allowed
    h.routine.test = [
      {
        ...h.assertion("customer-upgrade"),
        observe: async () => {
          allowed = false
          return {...proof("baseline", "target"), passed: false}
        },
      },
    ]
    expect(await runLifecycle(h.options)).toMatchObject({
      test: "failed",
      teardown: "deferred",
      fixture: "recovery-required",
    })
    expect(h.dispatched).toEqual(["baseline"])
    allowed = true
    expect(await recoverLifecycle(h.options)).toMatchObject({test: "failed", teardown: "passed", fixture: "ready"})
    expect(h.dispatched).toEqual(["baseline", "restore"])
  })
})

test("an active write blocks teardown until recovery independently observes it settled", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    const setup = h.routine.setup[0] as MutationStep
    const execute = setup.execute
    setup.execute = async (context, intent) => {
      await execute(context, intent)
      h.device.active = true
    }
    expect(await runLifecycle(h.options)).toMatchObject({
      test: "not-run",
      teardown: "deferred",
      fixture: "recovery-required",
    })
    expect(h.dispatched).toEqual(["baseline"])
    expect(h.releases).toBe(0)
    expect(h.retained.at(-1)).toMatchObject({reason: "unsettled-operation", recovering: false})
    expect((await recoverLifecycle(h.options)).fixture).toBe("recovery-required")
    expect(h.releases).toBe(0)
    expect(h.retained.at(-1)).toMatchObject({reason: "unsettled-operation", recovering: true})
    expect(h.dispatched).toEqual(["baseline"])
    h.device.active = false
    expect(await recoverLifecycle(h.options)).toMatchObject({test: "not-run", fixture: "ready"})
    expect(h.dispatched).toEqual(["baseline", "restore"])
    expect(h.releases).toBe(1)
  })
})

for (const status of ["active", "unknown"] as const) {
  test(`a dispatched ${status} customer operation retains exclusion until its owner proves it idle`, async () => {
    await fixture(async (folder) => {
      const h = harness(folder)
      const customer = h.routine.test[0] as MutationStep
      const execute = customer.execute
      const reconcile = customer.reconcile
      customer.execute = async (context, intent) => {
        await execute(context, intent)
        h.device.active = true
      }
      customer.reconcile = async (context, intent) => ({
        ...(await reconcile(context, intent)),
        ...(intent && h.device.active ? {status} : {}),
      })
      expect(await runLifecycle(h.options)).toMatchObject({
        test: "failed",
        teardown: "deferred",
        fixture: "recovery-required",
      })
      expect(h.releases).toBe(0)
      expect(h.retained.at(-1)).toMatchObject({
        reason: "unsettled-operation",
        runDirectory: h.options.runDirectory,
        selection: h.options.selection,
      })
      await expect(
        runLifecycle({
          ...h.options,
          runDirectory: join(folder, "next"),
          selection: {...h.options.selection, runID: "next-run"},
        }),
      ).rejects.toThrow("retained for its owning recovery")
      await expect(
        recoverLifecycle({...h.options, selection: {...h.options.selection, runID: "different-owner"}}),
      ).rejects.toThrow("retained for its owning recovery")
      expect((await recoverLifecycle(h.options)).fixture).toBe("recovery-required")
      expect(h.releases).toBe(0)
      h.device.active = false
      expect(await recoverLifecycle(h.options)).toMatchObject({test: "failed", fixture: "ready"})
      expect(h.releases).toBe(1)
      expect(h.dispatched).toEqual(["baseline", "upgrade"])
      expect(
        (await events(folder)).filter((event) => event.type === "mutation-intent" && event.stepID === "upgrade"),
      ).toHaveLength(1)
    })
  })
}

test("retention cleanup failure never falls back to releasing the shared lease", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    h.device.active = true
    h.options.onLeaseRetained = async () => {
      throw new Error("Recording cleanup failed")
    }
    // Let preflight establish identity so the subsequent mutation probe observes the busy writer.
    h.routine.preflight[0].observe = async () => ({...proof("identified", "identified"), passed: true})
    await expect(runLifecycle(h.options)).rejects.toThrow("Recording cleanup failed")
    expect(h.releases).toBe(0)
    expect((await fixtureRecord(folder)).status).toBe("recovery-required")
    await expect(runLifecycle(h.options)).rejects.toThrow("Resource lease is held")
  })
})

test("an unidentified pre-existing write also prevents cleanup mutations", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    h.routine.preflight[0].observe = async () => ({...proof("identified", "identified"), passed: true})
    h.device.active = true
    expect(await runLifecycle(h.options)).toMatchObject({teardown: "deferred", fixture: "recovery-required"})
    expect(h.dispatched).toEqual([])
    h.device.active = false
    expect((await recoverLifecycle(h.options)).fixture).toBe("ready")
    expect(h.dispatched).toEqual([])
  })
})

test("stale or missing evidence cannot pass preflight, and no setup mutation occurs", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    h.routine.preflight[0].observe = async () => ({
      ...proof("target", "target"),
      observedAt: "2020-01-01T00:00:00.000Z",
      passed: true,
    })
    expect(await runLifecycle(h.options)).toMatchObject({test: "not-run", fixture: "ready", outcome: "setup-failed"})
    expect(h.dispatched).toEqual([])
  })
})

test("failed identity preflight never restores an unqualified device even when its versions differ", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    h.device.version = "other-device-version"
    h.routine.preflight[0].observe = async () => ({...proof("wrong-physical-device", "fixture-one"), passed: false})
    expect(await runLifecycle(h.options)).toMatchObject({test: "not-run", fixture: "recovery-required"})
    expect(h.dispatched).toEqual([])
    expect(h.reconciled).toEqual([])
    expect(h.device.version).toBe("other-device-version")
  })
})

test("recovery rejects changed inputs instead of reinterpreting an old mutation intent", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    h.routine.preflight[0].observe = async () => ({...proof("identified", "identified"), passed: true})
    h.device.active = true
    await runLifecycle(h.options)
    await expect(
      recoverLifecycle({...h.options, routine: {...h.routine, definitionDigest: "different-code"}}),
    ).rejects.toThrow("definition changed")
    expect(h.releases).toBe(0)
    expect(h.retained.at(-1)).toMatchObject({reason: "incomplete-run", recovering: true})
    expect((await fixtureRecord(folder)).status).toBe("recovery-required")
    expect(h.dispatched).toEqual([])
  })
})

test("a second invocation cannot steal a live resource lease", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    const release = await h.options.acquireLease({
      recovering: false,
      runDirectory: h.options.runDirectory,
      selection: h.options.selection,
    })
    await expect(runLifecycle(h.options)).rejects.toThrow("Resource lease is held")
    await release()
    expect(h.dispatched).toEqual([])
  })
})

test("malformed fixture state cannot be treated as a new ready fixture", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    await mkdir(h.options.fixtureDirectory)
    const path = join(h.options.fixtureDirectory, "fixture.json")
    await writeFile(path, "null")
    await expect(runLifecycle(h.options)).rejects.toThrow("Invalid fixture ownership record")
    expect(await readFile(path, "utf8")).toBe("null")
    expect(h.dispatched).toEqual([])
  })
})

test("a real process crash after dispatch recovers from the journal without resending or restarting the test", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    const hardware = join(folder, "hardware.json")
    await writeFile(hardware, JSON.stringify({version: "target"}))
    const childSource = `
      import {readFile, writeFile} from "node:fs/promises";
      import {runLifecycle} from ${JSON.stringify(new URL("./lifecycle.ts", import.meta.url).href)};
      const directory = ${JSON.stringify(folder)};
      const proof = ${proof.toString()};
      const observe = async expected => { const {version} = JSON.parse(await readFile(directory + "/hardware.json", "utf8")); return {...proof(version, expected), passed: version === expected}; };
      const assertion = id => ({kind: "assertion", id, instruction: "Verify device.", observe: () => observe("target")});
      const mutation = (id, target) => ({kind: "mutation", id, instruction: "Install firmware.", repeat: "never",
        reconcile: async () => {const observation = await observe(target); return {...observation, status: observation.passed ? "satisfied" : "settled"};},
        execute: async () => { await writeFile(directory + "/hardware.json", JSON.stringify({version: target})); process.exit(73); }
      });
      await runLifecycle({runDirectory: directory + "/run", fixtureDirectory: directory + "/fixture",
        selection: ${JSON.stringify(h.options.selection)}, acquireLease: async () => async () => {},
        routine: {id: "simulated-ota", definitionDigest: "frozen-definition", preflight: [assertion("identity-power-recovery")],
          setup: [mutation("baseline", "baseline")], test: [mutation("upgrade", "target")], finalAssertions: [assertion("final-versions")],
          teardown: [mutation("restore", "target")], returnVerification: [assertion("return-versions-and-idle")], evidence: [assertion("recordings")]}
      });
    `
    const child = Bun.spawn([process.execPath, "--eval", childSource], {stdout: "pipe", stderr: "pipe"})
    expect({code: await child.exited, stderr: await new Response(child.stderr).text()}).toEqual({code: 73, stderr: ""})
    expect((await fixtureRecord(folder)).status).toBe("busy")
    expect((await events(folder)).at(-1)?.type).toBe("mutation-intent")
    await expect(runLifecycle({...h.options, runDirectory: join(folder, "next")})).rejects.toThrow("Fixture is busy")

    // The device has changed, but the summary can lag the authoritative intent journal.
    h.device.version = JSON.parse(await readFile(hardware, "utf8")).version
    await writeFile(join(folder, "run", "state.json"), "stale summary")
    const result = await recoverLifecycle(h.options)
    expect(result).toMatchObject({test: "not-run", fixture: "ready", outcome: "setup-failed"})
    expect(h.dispatched).toEqual(["restore"])
    expect(h.reconciled[0]).toBe("baseline")
    expect(
      (await events(folder)).filter((event) => event.type === "mutation-intent" && event.stepID === "baseline"),
    ).toHaveLength(1)
  })
}, 10000)

test("a damaged append-only journal fails closed and is never truncated to enable another dispatch", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    h.routine.preflight[0].observe = async () => ({...proof("identified", "identified"), passed: true})
    h.device.active = true
    await runLifecycle(h.options)
    const path = join(folder, "run", "events.jsonl")
    const damaged = (await readFile(path, "utf8")) + '{"sequence":'
    await writeFile(path, damaged)
    await expect(recoverLifecycle(h.options)).rejects.toThrow("Incomplete journal")
    expect(h.releases).toBe(0)
    expect(h.retained.at(-1)).toMatchObject({reason: "incomplete-run", recovering: true})
    expect(await readFile(path, "utf8")).toBe(damaged)
    expect((await fixtureRecord(folder)).status).toBe("recovery-required")
    expect(h.dispatched).toEqual([])
  })
})

test("checkpoint persistence failure stops all new actions; recovery uses the durable dispatch journal", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    const setup = h.routine.setup[0] as MutationStep
    const execute = setup.execute
    setup.execute = async (context, intent) => {
      const result = await execute(context, intent)
      const statePath = join(folder, "run", "state.json")
      await rm(statePath)
      await mkdir(statePath)
      return result
    }
    await expect(runLifecycle(h.options)).rejects.toThrow("Journal persistence failed")
    expect(h.dispatched).toEqual(["baseline"])
    expect(h.releases).toBe(0)
    expect(h.retained.at(-1)).toMatchObject({reason: "incomplete-run", recovering: false})
    expect((await fixtureRecord(folder)).status).toBe("busy")
    expect((await events(folder)).at(-1)?.type).toBe("mutation-dispatched")
    await rm(join(folder, "run", "state.json"), {recursive: true})
    expect(await recoverLifecycle(h.options)).toMatchObject({test: "not-run", fixture: "ready"})
    expect(h.dispatched).toEqual(["baseline", "restore"])
    expect(h.releases).toBe(1)
  })
})

test("result persistence failure retains exclusion even after all operations were observed settled", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    const evidence = h.routine.evidence[0]
    const observe = evidence.observe
    evidence.observe = async (context) => {
      await mkdir(join(h.options.runDirectory, "result.json"))
      return observe(context)
    }
    await expect(runLifecycle(h.options)).rejects.toThrow()
    expect((await events(folder)).at(-1)?.type).toBe("run-finished")
    expect(h.releases).toBe(0)
    expect(h.retained.at(-1)).toMatchObject({reason: "incomplete-run"})
    expect((await fixtureRecord(folder)).status).toBe("busy")
    await rm(join(h.options.runDirectory, "result.json"), {recursive: true})
    evidence.observe = observe
    expect(await recoverLifecycle(h.options)).toMatchObject({test: "passed", fixture: "ready"})
    expect(h.releases).toBe(1)
    expect(h.dispatched).toEqual(["baseline", "upgrade"])
  })
})

test("same-owner recovery of a committed ready fixture requires fresh return proof without replay", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    const step = h.routine.returnVerification[0]
    const observe = step.observe
    let returnReads = 0
    step.observe = async (context) => {
      returnReads++
      return observe(context)
    }
    expect((await runLifecycle(h.options)).fixture).toBe("ready")
    const descriptor = await readFile(join(h.options.runDirectory, "run.json"), "utf8")
    const sequence = (await events(folder)).at(-1)!.sequence
    expect(returnReads).toBe(1)
    expect(await recoverLifecycle(h.options)).toMatchObject({test: "passed", fixture: "ready"})
    expect(returnReads).toBe(2)
    expect(h.dispatched).toEqual(["baseline", "upgrade"])
    expect(await readFile(join(h.options.runDirectory, "run.json"), "utf8")).toBe(descriptor)
    const journal = await events(folder)
    expect(journal.filter((event) => event.type === "mutation-intent")).toHaveLength(2)
    expect(
      journal.find((event) => event.sequence > sequence && event.stepID === step.id && event.type === "assertion"),
    ).toMatchObject({details: {passed: true, source: "simulated-device"}})
    await expect(
      recoverLifecycle({...h.options, selection: {...h.options.selection, runID: "different-owner"}}),
    ).rejects.toThrow("Recovery requires the owning fixture")
    expect(await readFile(join(h.options.runDirectory, "run.json"), "utf8")).toBe(descriptor)
  })
})

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

test("terminal snapshots pin the exact UTF-8 journal prefix, state and separate base result", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    h.routine.preflight[0].instruction = "Verify glasses → prêt."
    const {terminal, ...result} = await runLifecycle(h.options)
    const raw = await readFile(join(h.options.runDirectory, terminal.path))
    const snapshot = JSON.parse(raw.toString()) as LifecycleTerminalSnapshot
    const journal = await readFile(join(h.options.runDirectory, "events.jsonl"))
    const last = (await events(folder)).at(-1)!
    expect(terminal).toEqual({path: `terminals/${last.sequence}.json`, sha256: digest(raw)})
    expect(snapshot).toEqual({
      schemaVersion: 1,
      generation: 1,
      previous: null,
      journal: {sequence: last.sequence, bytes: journal.length, sha256: digest(journal)},
      state: last.state,
      result,
    })
    expect(journal.length).toBeGreaterThan(journal.toString().length)
    expect(JSON.parse(await readFile(join(h.options.runDirectory, "result.json"), "utf8"))).toEqual(result)
    expect(await readdir(join(h.options.runDirectory, "terminals"))).toEqual([`${last.sequence}.json`])
  })
})

test("later terminal generations preserve the original failure while recording a freshly recovered return", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    const upgrade = h.routine.test[0] as MutationStep
    const execute = upgrade.execute
    upgrade.execute = async (context, intent) => {
      const result = await execute(context, intent)
      h.device.active = true
      return result
    }
    const first = await runLifecycle(h.options)
    const firstBytes = await readFile(join(h.options.runDirectory, first.terminal.path))
    const firstJournal = await readFile(join(h.options.runDirectory, "events.jsonl"))
    expect(first).toMatchObject({test: "failed", teardown: "deferred", fixture: "recovery-required"})
    const second = await recoverLifecycle(h.options)
    const secondBytes = await readFile(join(h.options.runDirectory, second.terminal.path))
    expect(second).toMatchObject({test: "failed", fixture: "recovery-required"})
    h.device.active = false
    const third = await recoverLifecycle(h.options)
    const thirdBytes = await readFile(join(h.options.runDirectory, third.terminal.path))
    expect(third).toMatchObject({test: "failed", teardown: "passed", returnVerification: "passed", fixture: "ready"})
    expect(await readFile(join(h.options.runDirectory, first.terminal.path))).toEqual(firstBytes)
    expect(await readFile(join(h.options.runDirectory, second.terminal.path))).toEqual(secondBytes)
    expect(JSON.parse(secondBytes.toString())).toMatchObject({generation: 2, previous: first.terminal})
    expect(JSON.parse(thirdBytes.toString())).toMatchObject({generation: 3, previous: second.terminal})
    const journal = await readFile(join(h.options.runDirectory, "events.jsonl"))
    expect(journal.subarray(0, firstJournal.length)).toEqual(firstJournal)
    for (const [bytes, ref] of [
      [firstBytes, first.terminal],
      [secondBytes, second.terminal],
      [thirdBytes, third.terminal],
    ] as const) {
      const snapshot = JSON.parse(bytes.toString()) as LifecycleTerminalSnapshot
      expect(digest(bytes)).toBe(ref.sha256)
      expect(digest(journal.subarray(0, snapshot.journal.bytes))).toBe(snapshot.journal.sha256)
    }
    expect((await events(folder)).filter((event) => event.type === "test-frozen")).toHaveLength(1)
    expect(h.dispatched).toEqual(["baseline", "upgrade"])
    expect(h.releases).toBe(1)
  })
})

for (const damage of ["snapshot", "previous", "prefix", "orphan", "symlink", "hardlink"] as const) {
  test(`recovery rejects ${damage} terminal damage before appending or observing, retaining exclusion`, async () => {
    await fixture(async (folder) => {
      const h = harness(folder)
      const first = await runLifecycle(h.options)
      const second = await recoverLifecycle(h.options)
      const path = join(h.options.runDirectory, first.terminal.path)
      const journalPath = join(h.options.runDirectory, "events.jsonl")
      if (damage === "snapshot") await writeFile(path, "{incomplete")
      if (damage === "previous") {
        const later = join(h.options.runDirectory, second.terminal.path)
        const snapshot = JSON.parse(await readFile(later, "utf8")) as LifecycleTerminalSnapshot
        snapshot.previous = {...first.terminal, sha256: "f".repeat(64)}
        await writeFile(later, JSON.stringify(snapshot, null, 2) + "\n")
      }
      if (damage === "prefix") {
        const journal = await readFile(journalPath, "utf8")
        await writeFile(journalPath, journal.replace("Verify identity-power-recovery.", "Changed prior instruction."))
      }
      if (damage === "orphan") await writeFile(join(h.options.runDirectory, "terminals/99999.json"), "{}\n")
      if (damage === "hardlink") await link(path, join(folder, "unowned-snapshot-alias.json"))
      if (damage === "symlink") {
        const copy = join(folder, "outside.json")
        await writeFile(copy, await readFile(path))
        await rm(path)
        await symlink(copy, path)
      }
      const before = await readFile(journalPath)
      const reads = h.reconciled.length
      await expect(recoverLifecycle(h.options)).rejects.toThrow("Terminal snapshot")
      expect(await readFile(journalPath)).toEqual(before)
      expect(h.reconciled).toHaveLength(reads)
      expect(h.dispatched).toEqual(["baseline", "upgrade"])
      expect(h.releases).toBe(2)
      expect(h.retained.at(-1)).toMatchObject({recovering: true, reason: "incomplete-run"})
    })
  })
}

test("snapshot publication failure retains the terminal journal and reconstructs it before recovery", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    const evidence = h.routine.evidence[0]
    const observe = evidence.observe
    evidence.observe = async (context) => {
      // Simulate a filesystem failure after the committed terminal journal, before
      // any canonical terminal file can be published.
      await writeFile(join(h.options.runDirectory, "terminals"), "unavailable")
      return observe(context)
    }
    await expect(runLifecycle(h.options)).rejects.toThrow()
    const journal = await readFile(join(h.options.runDirectory, "events.jsonl"))
    const last = (await events(folder)).at(-1)!
    expect(last.type).toBe("run-finished")
    expect(h.releases).toBe(0)
    expect(h.retained.at(-1)?.reason).toBe("incomplete-run")
    expect((await fixtureRecord(folder)).status).toBe("busy")
    await rm(join(h.options.runDirectory, "terminals"))
    await mkdir(join(h.options.runDirectory, "terminals"))
    const temporary = `${last.sequence}.json.00000000-0000-0000-0000-000000000000.tmp`
    await writeFile(join(h.options.runDirectory, "terminals", temporary), "partial temporary write")
    evidence.observe = observe
    const recovered = await recoverLifecycle(h.options)
    const originalPath = `terminals/${last.sequence}.json`
    const originalBytes = await readFile(join(h.options.runDirectory, originalPath))
    expect(JSON.parse(originalBytes.toString())).toEqual({
      schemaVersion: 1,
      generation: 1,
      previous: null,
      journal: {sequence: last.sequence, bytes: journal.length, sha256: digest(journal)},
      state: last.state,
      result: last.details,
    })
    expect(JSON.parse(await readFile(join(h.options.runDirectory, recovered.terminal.path), "utf8"))).toMatchObject({
      generation: 2,
      previous: {path: originalPath, sha256: digest(originalBytes)},
    })
    expect(recovered).toMatchObject({test: "passed", fixture: "ready"})
    expect(h.dispatched).toEqual(["baseline", "upgrade"])
    expect(h.releases).toBe(1)
  })
})

test("recovery removes only the committed snapshot's abandoned publication hard link", async () => {
  await fixture(async (folder) => {
    const h = harness(folder)
    const first = await runLifecycle(h.options)
    const path = join(h.options.runDirectory, first.terminal.path)
    const committed = await readFile(path)
    const alias = `${path}.00000000-0000-0000-0000-000000000000.tmp`
    const partial = `${path}.11111111-1111-1111-1111-111111111111.tmp`
    await link(path, alias)
    await writeFile(partial, "uncommitted partial snapshot")
    expect((await lstat(path)).nlink).toBe(2)
    const recovered = await recoverLifecycle(h.options)
    expect(recovered.fixture).toBe("ready")
    expect(await readFile(path)).toEqual(committed)
    expect((await lstat(path)).nlink).toBe(1)
    await expect(lstat(alias)).rejects.toThrow("ENOENT")
    expect(await readFile(partial, "utf8")).toBe("uncommitted partial snapshot")
    expect(JSON.parse(await readFile(join(h.options.runDirectory, recovered.terminal.path), "utf8"))).toMatchObject({
      generation: 2,
      previous: first.terminal,
    })
    expect(h.dispatched).toEqual(["baseline", "upgrade"])
  })
})
