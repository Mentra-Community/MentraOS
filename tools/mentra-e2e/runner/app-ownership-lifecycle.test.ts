import {expect, test} from "bun:test"
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {acquireAppOwnership} from "../../../mobile/scripts/app-ownership.mjs"
import type {LifecycleEvent} from "./lifecycle"

// Only device/recorder adapters are simulated. Each worker uses the production
// lifecycle, cleanup wiring and shared lock, then exits before the next owner.
const workerSource = `
  import {appendFile, readFile, writeFile} from "node:fs/promises";
  import {join} from "node:path";
  const [folder, mode, lifecycleModule, ownershipModule] = process.argv.slice(1);
  const {runLifecycle, recoverLifecycle} = await import(lifecycleModule);
  const {lifecycleAppOwnership} = await import(ownershipModule);
  const hardware = join(folder, "hardware.json");
  const readDevice = async () => JSON.parse(await readFile(hardware, "utf8"));
  const proof = actual => ({actual, expected: {version: "target", status: "idle"},
    observedAt: new Date().toISOString(), source: "simulated-device-read", evidence: [hardware]});
  const assertion = (id, verifyDevice = false) => ({kind: "assertion", id, instruction: "Verify fresh evidence.",
    observe: async () => {const device = await readDevice(); return {...proof(device),
      passed: !verifyDevice || (device.version === "target" && device.status === "idle")};}});
  const upgrade = {kind: "mutation", id: "upgrade", instruction: "Install the selected target.", repeat: "never",
    execute: async (_context, intent) => {
      await appendFile(join(folder, "dispatches.jsonl"), JSON.stringify({operationID: intent.operationID}) + "\\n");
      await writeFile(hardware, JSON.stringify({version: "target",
        status: ["settled", "cleanup-fails"].includes(mode) ? "idle" : mode === "unknown" ? "unknown" : "active"}));
      if (mode === "interrupted") process.kill(process.pid, "SIGKILL");
      return {accepted: true};
    },
    reconcile: async () => {const device = await readDevice(); return {...proof(device),
      status: device.status !== "idle" ? device.status : device.version === "target" ? "satisfied" : "settled"};}
  };
  const options = {
    runDirectory: join(folder, "run"), fixtureDirectory: join(folder, "fixture"),
    selection: {runID: "run-one", fixtureID: "fixture-one", returnProfileDigest: "target-digest", inputs: {build: "candidate"}},
    ...lifecycleAppOwnership(join(folder, "locks"), async () => {
      await appendFile(join(folder, "cleanups.jsonl"), JSON.stringify({mode}) + "\\n");
      if (mode === "cleanup-fails") throw new Error("simulated recorder cleanup failed");
    }),
    routine: {id: "simulated-ota", definitionDigest: "frozen-definition",
      preflight: [assertion("identity")], setup: [], test: [upgrade], finalAssertions: [assertion("final", true)],
      teardown: [], returnVerification: [assertion("return", true)], evidence: [assertion("recordings")]},
  };
  try {
    console.log(JSON.stringify(await (mode === "recover" ? recoverLifecycle(options) : runLifecycle(options))));
  } catch (error) {
    console.log(JSON.stringify({error: String(error)}));
    process.exitCode = 1;
  }
`

async function worker(folder: string, mode: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      workerSource,
      folder,
      mode,
      new URL("./lifecycle.ts", import.meta.url).href,
      new URL("./lifecycle-app-ownership.ts", import.meta.url).href,
    ],
    {stdout: "pipe", stderr: "pipe"},
  )
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 10000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(timedOut).toBe(false)
    expect(stderr).toBe("")
    return {pid: child.pid, code, signal: child.signalCode, stdout}
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) {
      child.kill("SIGKILL")
      await child.exited
    }
  }
}

async function fixture(run: (folder: string, lock: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "mentra-app-lifecycle-"))
  try {
    await writeFile(join(folder, "hardware.json"), JSON.stringify({version: "baseline", status: "idle"}))
    await run(folder, join(folder, "locks", "com.mentra.mentra.lock"))
  } finally {
    await rm(folder, {recursive: true, force: true})
  }
}

async function events(folder: string): Promise<LifecycleEvent[]> {
  return (await readFile(join(folder, "run", "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
}

for (const mode of ["active", "unknown", "interrupted"] as const) {
  test(`real ${mode} lifecycle worker retains the app across process exit until its own idle recovery`, async () => {
    await fixture(async (folder, lock) => {
      const child = await worker(folder, mode)
      if (mode === "interrupted") {
        expect(child.signal).toBe("SIGKILL")
        expect((await events(folder)).at(-1)?.type).toBe("mutation-intent")
        await expect(readFile(join(folder, "cleanups.jsonl"))).rejects.toMatchObject({code: "ENOENT"})
      } else {
        expect(child.code).toBe(0)
        expect(JSON.parse(child.stdout)).toMatchObject({test: "failed", fixture: "recovery-required", teardown: "deferred"})
        expect(await readFile(join(folder, "cleanups.jsonl"), "utf8")).toBe(JSON.stringify({mode}) + "\n")
      }
      expect(() => process.kill(child.pid, 0)).toThrow()
      const reserved = await readFile(lock, "utf8")
      const reservation = {runID: "run-one", runDirectory: join(folder, "run"), fixtureID: "fixture-one"}
      expect(JSON.parse(reserved)).toMatchObject({pid: child.pid, retainOnExit: true, reservation})
      const lockFolder = join(folder, "locks")
      for (const options of [
        {installer: true},
        {},
        {reservation: {...reservation, runID: "different-run"}, recovering: true},
      ]) {
        await expect(acquireAppOwnership(lockFolder, options)).rejects.toThrow("Mentra is owned")
        expect(await readFile(lock, "utf8")).toBe(reserved)
      }

      const frozenRun = await readFile(join(folder, "run", "run.json"), "utf8")
      const dispatches = await readFile(join(folder, "dispatches.jsonl"), "utf8")
      expect(dispatches.trim().split("\n")).toHaveLength(1)
      const priorSequence = (await events(folder)).at(-1)!.sequence
      // A new read-only reconciliation can now observe the writer settled;
      // recovery receives the same frozen inputs and never reruns the mutation.
      await writeFile(join(folder, "hardware.json"), JSON.stringify({version: "target", status: "idle"}))
      const recovered = await worker(folder, "recover")
      expect(recovered.code).toBe(0)
      expect(JSON.parse(recovered.stdout)).toMatchObject({test: "failed", fixture: "ready", teardown: "passed"})
      expect(await readFile(join(folder, "run", "run.json"), "utf8")).toBe(frozenRun)
      expect(await readFile(join(folder, "dispatches.jsonl"), "utf8")).toBe(dispatches)
      expect((await readFile(join(folder, "cleanups.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))).toEqual(
        [...(mode === "interrupted" ? [] : [{mode}]), {mode: "recover"}],
      )
      const journal = await events(folder)
      expect(journal.filter((event) => event.type === "mutation-intent")).toHaveLength(1)
      expect(journal.find((event) => event.sequence > priorSequence && event.type === "reconciliation")?.details).toMatchObject({
        status: "satisfied", actual: {version: "target", status: "idle"}, source: "simulated-device-read",
      })
      await expect(readFile(lock)).rejects.toMatchObject({code: "ENOENT"})
      const release = await acquireAppOwnership(lockFolder, {installer: true})
      await release()
    })
  }, 20000)
}

test("a normally settled lifecycle worker releases the real app lock before exiting", async () => {
  await fixture(async (folder, lock) => {
    const child = await worker(folder, "settled")
    expect(child.code).toBe(0)
    expect(JSON.parse(child.stdout)).toMatchObject({test: "passed", fixture: "ready", outcome: "passed"})
    expect(await readFile(join(folder, "cleanups.jsonl"), "utf8")).toBe(JSON.stringify({mode: "settled"}) + "\n")
    await expect(readFile(lock)).rejects.toMatchObject({code: "ENOENT"})
    expect((await readFile(join(folder, "dispatches.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1)
    const release = await acquireAppOwnership(join(folder, "locks"), {installer: true})
    await release()
  })
}, 20000)

test("production cleanup failure retains the app until the same settled run recovers without replay", async () => {
  await fixture(async (folder, lock) => {
    const child = await worker(folder, "cleanup-fails")
    expect(child.code).toBe(1)
    expect(JSON.parse(child.stdout).error).toContain("simulated recorder cleanup failed")
    expect(JSON.parse(await readFile(join(folder, "run", "result.json"), "utf8"))).toMatchObject({
      test: "passed", fixture: "ready", outcome: "passed",
    })
    expect(await readFile(join(folder, "cleanups.jsonl"), "utf8")).toBe(JSON.stringify({mode: "cleanup-fails"}) + "\n")
    const reserved = await readFile(lock, "utf8")
    expect(JSON.parse(reserved)).toMatchObject({pid: child.pid, retainOnExit: true, reservation: {runID: "run-one"}})
    await expect(acquireAppOwnership(join(folder, "locks"), {installer: true})).rejects.toThrow("Mentra is owned")
    expect(await readFile(lock, "utf8")).toBe(reserved)

    const frozenRun = await readFile(join(folder, "run", "run.json"), "utf8")
    const dispatches = await readFile(join(folder, "dispatches.jsonl"), "utf8")
    expect(dispatches.trim().split("\n")).toHaveLength(1)
    const priorSequence = (await events(folder)).at(-1)!.sequence
    await writeFile(join(folder, "hardware.json"), JSON.stringify({version: "target", status: "idle"}))
    const recoveryStartedAt = Date.now()
    const recovered = await worker(folder, "recover")
    expect(recovered.code).toBe(0)
    expect(JSON.parse(recovered.stdout)).toMatchObject({test: "passed", fixture: "ready", outcome: "passed"})
    expect(await readFile(join(folder, "run", "run.json"), "utf8")).toBe(frozenRun)
    expect(await readFile(join(folder, "dispatches.jsonl"), "utf8")).toBe(dispatches)
    const journal = await events(folder)
    expect(journal.filter((event) => event.type === "mutation-intent")).toHaveLength(1)
    const returnProof = journal.find((event) => event.sequence > priorSequence && event.type === "assertion" && event.stepID === "return")
    expect(returnProof?.details).toMatchObject({
      passed: true, actual: {version: "target", status: "idle"}, source: "simulated-device-read",
    })
    expect(Date.parse((returnProof!.details as {observedAt: string}).observedAt)).toBeGreaterThanOrEqual(recoveryStartedAt)
    expect(await readFile(join(folder, "cleanups.jsonl"), "utf8")).toBe(
      JSON.stringify({mode: "cleanup-fails"}) + "\n" + JSON.stringify({mode: "recover"}) + "\n",
    )
    await expect(readFile(lock)).rejects.toMatchObject({code: "ENOENT"})
    const release = await acquireAppOwnership(join(folder, "locks"), {installer: true})
    await release()
  })
}, 20000)
