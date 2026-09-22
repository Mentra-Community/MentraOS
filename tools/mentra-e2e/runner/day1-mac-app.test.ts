import {expect, test} from "bun:test"
import {createHash, randomUUID} from "node:crypto"
import {existsSync, readFileSync, writeSync} from "node:fs"
import {chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {createDay1MacAppStep, type Day1MacAppInputs, type Day1MacAppProcesses} from "./day1-mac-app"
import {
  recoverLifecycle,
  runLifecycle,
  type LifecycleContext,
  type LifecycleOptions,
  type MutationIntent,
} from "./lifecycle"

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "mentra-mac-step-")))
  try {
    await body(await setup(folder))
  } finally {
    await rm(folder, {recursive: true, force: true})
  }
}
async function setup(folder: string) {
  const wrapper = join(folder, "Mentra.app"),
    inner = join(wrapper, "Wrapper", "Mentra.app")
  await mkdir(inner, {recursive: true})
  await symlink("Wrapper/Mentra.app", join(wrapper, "WrappedBundle"))
  const info = {
    CFBundleIdentifier: "com.mentra.mentra",
    CFBundleExecutable: "Mentra",
    CFBundleShortVersionString: "3.3.0",
    CFBundleVersion: "303000123",
  }
  const infoBytes = JSON.stringify(info)
  await writeFile(join(inner, "Info.plist"), infoBytes)
  await writeFile(join(inner, "Mentra"), "synthetic binary")
  await writeFile(join(inner, "main.jsbundle"), "synthetic javascript")
  const ci = {
    pr: 123,
    headSha: "a".repeat(40),
    buildSha: "b".repeat(40),
    runId: 456789,
    runAttempt: 2,
    bundleId: info.CFBundleIdentifier,
    app: "Mentra.app",
    backend: "dev",
    otaManifestUrl: `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/pr-builds/ota-pr-123-${"a".repeat(40)}.json`,
    macPackageVersion: 2,
    macInstaller: "Install Mentra.app",
    mobileFingerprint: "f".repeat(64),
    mobileSourceCommit: "c".repeat(40),
    reusedCompilation: true,
    version: info.CFBundleShortVersionString,
    build: info.CFBundleVersion,
    executableSha256: hash("synthetic binary"),
    javascriptSha256: hash("synthetic javascript"),
    profileUUID: "12345678-1234-1234-1234-123456789abc",
    profileExpires: "2027-05-28T04:05:18",
    teamId: "T5XXXL6N36",
  }
  const manifest = join(folder, "build.json"),
    launcher = join(folder, "launch-ios-on-mac"),
    driver = join(folder, "mentra-driver")
  await writeFile(manifest, JSON.stringify(ci))
  await writeFile(launcher, "synthetic pinned launcher")
  await chmod(launcher, 0o755)
  await writeFile(driver, "synthetic pinned driver")
  await chmod(driver, 0o755)
  const leasePath = join(folder, "lease.json")
  const acquire = async () => {
    await writeFile(leasePath, JSON.stringify({pid: process.pid, token: randomUUID()}), {flag: "wx", mode: 0o600})
    return () => rm(leasePath)
  }
  const base = {
    manifest: {path: manifest, sha256: hash(JSON.stringify(ci))},
    launcher: {path: launcher, sha256: hash("synthetic pinned launcher")},
    driver: {path: driver, sha256: hash("synthetic pinned driver")},
    wrapperPath: wrapper,
    infoPlistSha256: hash(infoBytes),
    leasePath,
  }
  const selected = (action: "stop" | "launch", phase: "setup" | "teardown" = "setup"): Day1MacAppInputs => ({
    ...base,
    id: `${phase}-mac-${action}`,
    action,
    phase,
  })
  const doctor = {
    pid: 4321,
    bundleId: info.CFBundleIdentifier,
    bundlePath: inner,
    executablePath: join(inner, "Mentra"),
    javascriptPath: join(inner, "main.jsbundle"),
    version: info.CFBundleShortVersionString,
    build: info.CFBundleVersion,
    accessibility: false,
    screenCapture: false,
    postEvents: false,
    frontmostBundleId: "test-only",
  }
  let app: typeof doctor | null = {...doctor}
  let extraApps = false,
    badDoctor = false,
    refuse = false,
    crash = false,
    childAlive = false
  let onDoctor: (() => void) | undefined
  const commands: {argv: string[]; stdin?: string}[] = []
  const runtime: Day1MacAppProcesses = {
    isAlive: () => childAlive,
    spawn(command) {
      commands.push({argv: [...command.argv], stdin: command.stdin})
      let output: unknown,
        exitCode = 0
      if (command.argv[0] === "/usr/bin/plutil") {
        output = JSON.parse(readFileSync(command.argv.at(-1)!, "utf8"))
      } else if (command.argv[0] === driver) {
        expect(JSON.parse(command.stdin!)).toEqual({op: "doctor", bundleId: ci.bundleId})
        onDoctor?.()
        if (badDoctor) {
          output = {ok: false, error: "Accessibility failed"}
          exitCode = 1
        } else if (extraApps || !app) {
          output = {ok: false, error: `Expected one running ${ci.bundleId} process, found ${extraApps ? 2 : 0}`}
          exitCode = 1
        } else output = {ok: true, result: app}
      } else if (command.argv[0] === launcher) {
        const stopping = command.argv[1] === "--quit"
        expect(command.argv.slice(1)).toEqual(stopping ? ["--quit", wrapper] : [wrapper])
        // Runtime observes the actual lifecycle/private intent before dispatch.
        const intentPath = join(
          folder,
          "run",
          "day1-mac-app",
          `${stopping ? "setup-mac-stop" : "setup-mac-launch"}`,
          "dispatch-intent.json",
        )
        expect(JSON.parse(readFileSync(intentPath, "utf8")).automaticRetry).toBe(false)
        const eventsPath = join(folder, "run", "events.jsonl")
        if (existsSync(eventsPath)) {
          const last = JSON.parse(readFileSync(eventsPath, "utf8").trim().split("\n").at(-1)!)
          expect(last.type).toBe("mutation-intent")
          expect(last.details.operationID).toBe(JSON.parse(readFileSync(intentPath, "utf8")).owner)
        }
        if (crash) return {pid: 7654, exited: Promise.reject(new Error("synthetic interruption"))}
        if (refuse) exitCode = 1
        else app = stopping ? null : {...doctor, pid: 5321}
        output = stopping ? "normal termination" : "normal launch"
      } else throw new Error("Unexpected test command")
      writeSync(command.stdout, typeof output === "string" ? output : JSON.stringify(output))
      return {pid: 7654, exited: Promise.resolve(exitCode)}
    },
  }
  const context: LifecycleContext = {
    runDirectory: join(folder, "run"),
    selection: {
      runID: "synthetic-mac-run",
      fixtureID: "synthetic-fixture",
      returnProfileDigest: "synthetic-return",
      inputs: {},
    },
    operations: [],
  }
  const intent = (action: "stop" | "launch") => {
    const value: MutationIntent = {
      operationID: randomUUID(),
      stepID: selected(action).id,
      phase: "setup",
      startedAt: new Date().toISOString(),
    }
    context.operations = [...context.operations, value]
    return value
  }
  return {
    folder,
    inner,
    ci,
    base,
    selected,
    runtime,
    context,
    intent,
    acquire,
    commands,
    doctor,
    get app() {
      return app
    },
    set app(value) {
      app = value
    },
    set extraApps(value: boolean) {
      extraApps = value
    },
    set badDoctor(value: boolean) {
      badDoctor = value
    },
    set refuse(value: boolean) {
      refuse = value
    },
    set crash(value: boolean) {
      crash = value
    },
    set childAlive(value: boolean) {
      childAlive = value
    },
    set onDoctor(value: (() => void) | undefined) {
      onDoctor = value
    },
  }
}
const launchCommands = (f: Awaited<ReturnType<typeof setup>>) =>
  f.commands.filter((c) => c.argv[0] === f.base.launcher.path)

function assertion(id: string) {
  return {
    id,
    kind: "assertion" as const,
    instruction: "Synthetic test assertion.",
    observe: async () => ({
      passed: true,
      expected: true,
      actual: true,
      observedAt: new Date().toISOString(),
      source: "test only",
      evidence: ["/private/synthetic-proof.json"],
    }),
  }
}

test("real lifecycle journals stop then launch, with private command evidence and exact CI compilation provenance", () =>
  fixture(async (f) => {
    const steps = [
      createDay1MacAppStep(f.selected("stop"), f.runtime),
      createDay1MacAppStep(f.selected("launch"), f.runtime),
    ]
    const options: LifecycleOptions = {
      runDirectory: f.context.runDirectory,
      fixtureDirectory: join(f.folder, "fixture"),
      selection: f.context.selection,
      acquireLease: f.acquire,
      routine: {
        id: "synthetic-mac",
        definitionDigest: "synthetic-definition",
        preflight: [assertion("preflight")],
        setup: steps,
        test: [],
        finalAssertions: [assertion("final")],
        teardown: [],
        returnVerification: [assertion("return")],
        evidence: [assertion("evidence")],
      },
    }
    await runLifecycle(options)
    expect(launchCommands(f).map((c) => c.argv)).toEqual([
      [f.base.launcher.path, "--quit", f.base.wrapperPath],
      [f.base.launcher.path, f.base.wrapperPath],
    ])
    const state = JSON.parse(await readFile(join(f.context.runDirectory, "state.json"), "utf8"))
    expect(state.operations).toHaveLength(2)
    expect(state.operations.every((x: any) => x.reconciliation.status === "satisfied")).toBe(true)
    const actual = state.operations[1].reconciliation.actual
    expect(actual.provenance.verifiedCiBuild).toEqual(f.ci)
    expect(actual.provenance.installedAppCommit).toBe(f.ci.mobileSourceCommit)
    expect(actual.provenance).not.toHaveProperty("verifiedLocalBuild")
    const log = state.operations[0].dispatch.evidence.find((p: string) => p.endsWith("dispatch/result.json"))
    const command = JSON.parse(await readFile(log, "utf8"))
    expect(command.exitCode).toBe(0)
    expect(command.finishedAt).toBeGreaterThanOrEqual(command.startedAt)
    await expect((await import("node:fs/promises")).stat(log).then((s) => s.mode & 0o777)).resolves.toBe(0o600)
  }))

test("absent stop and already-running launch are satisfied without a launcher call", () =>
  fixture(async (f) => {
    const release = await f.acquire()
    f.app = null
    expect((await createDay1MacAppStep(f.selected("stop"), f.runtime).reconcile(f.context)).status).toBe("satisfied")
    f.app = {...f.doctor}
    expect((await createDay1MacAppStep(f.selected("launch", "teardown"), f.runtime).reconcile(f.context)).status).toBe(
      "satisfied",
    )
    expect(launchCommands(f)).toHaveLength(0)
    await release()
  }))

test("wrong, multiple or unreadable running apps never become an absence proof", () =>
  fixture(async (f) => {
    const release = await f.acquire(),
      step = createDay1MacAppStep(f.selected("stop"), f.runtime)
    f.extraApps = true
    await expect(step.reconcile(f.context)).rejects.toThrow("single selected")
    f.extraApps = false
    f.badDoctor = true
    await expect(step.reconcile(f.context)).rejects.toThrow("single selected")
    f.badDoctor = false
    f.app = {...f.doctor, build: "1"}
    await expect(step.reconcile(f.context)).rejects.toThrow("differs")
    await writeFile(join(f.folder, "another-binary"), "synthetic binary")
    f.app = {...f.doctor, executablePath: join(f.folder, "another-binary")}
    await expect(step.reconcile(f.context)).rejects.toThrow("contained")
    expect(launchCommands(f)).toHaveLength(0)
    await release()
  }))

test("changed app bytes and Info.plist are rejected before mutation", () =>
  fixture(async (f) => {
    const release = await f.acquire(),
      step = createDay1MacAppStep(f.selected("stop"), f.runtime)
    await writeFile(join(f.inner, "main.jsbundle"), "changed")
    await expect(step.reconcile(f.context)).rejects.toThrow("does not match")
    await writeFile(join(f.inner, "main.jsbundle"), "synthetic javascript")
    await writeFile(join(f.inner, "Info.plist"), "changed")
    await expect(step.reconcile(f.context)).rejects.toThrow("hash")
    expect(launchCommands(f)).toHaveLength(0)
    await release()
  }))

test("launch rechecks absence immediately before dispatch and does not replace an arriving app", () =>
  fixture(async (f) => {
    const release = await f.acquire(),
      step = createDay1MacAppStep(f.selected("launch"), f.runtime),
      intent = f.intent("launch")
    f.app = null
    let doctors = 0
    f.onDoctor = () => {
      if (++doctors === 3) f.app = {...f.doctor}
    }
    await expect(step.execute(f.context, intent)).rejects.toThrow("changed before dispatch")
    expect(launchCommands(f)).toHaveLength(0)
    await release()
  }))

test("refused normal termination remains unknown and cannot be dispatched twice", () =>
  fixture(async (f) => {
    const release = await f.acquire(),
      step = createDay1MacAppStep(f.selected("stop"), f.runtime),
      intent = f.intent("stop")
    f.refuse = true
    await step.execute(f.context, intent)
    expect((await step.reconcile(f.context, intent)).status).toBe("unknown")
    await expect(step.execute(f.context, intent)).rejects.toThrow("never be repeated")
    expect(launchCommands(f)).toHaveLength(1)
    await release()
  }))

test("interrupted dispatch waits for the old helper to exit and only fresh goal proof settles it", () =>
  fixture(async (f) => {
    const release = await f.acquire(),
      step = createDay1MacAppStep(f.selected("stop"), f.runtime),
      intent = f.intent("stop")
    f.crash = true
    await expect(step.execute(f.context, intent)).rejects.toThrow("interruption")
    f.app = null
    f.childAlive = true
    expect((await step.reconcile(f.context, intent)).status).toBe("active")
    await release()
    const releaseAgain = await f.acquire()
    f.childAlive = false
    const recoveredStep = createDay1MacAppStep(f.selected("stop"), f.runtime)
    expect((await recoveredStep.reconcile(f.context, intent)).status).toBe("satisfied")
    await expect(recoveredStep.execute(f.context, intent)).rejects.toThrow("never be repeated")
    expect(launchCommands(f)).toHaveLength(1)
    await releaseAgain()
  }))

test("wrong lease and mismatched lifecycle ownership prevent every subprocess", () =>
  fixture(async (f) => {
    const step = createDay1MacAppStep(f.selected("stop"), f.runtime)
    await expect(step.reconcile(f.context)).rejects.toThrow()
    expect(f.commands).toHaveLength(0)
    const release = await f.acquire(),
      intent = f.intent("stop")
    await expect(step.execute(f.context, {...intent, operationID: randomUUID()})).rejects.toThrow("durable")
    await writeFile(f.base.leasePath, JSON.stringify({pid: process.pid + 100, token: "other-owner"}))
    await expect(step.execute(f.context, intent)).rejects.toThrow("live fixture lease")
    expect(f.commands).toHaveLength(0)
    await release()
  }))

test("frozen input refs and manifest bytes survive caller mutation and reject a different recovery selection", () =>
  fixture(async (f) => {
    const release = await f.acquire(),
      input = f.selected("stop"),
      step = createDay1MacAppStep(input, f.runtime)
    input.wrapperPath = join(f.folder, "wrong")
    expect((await step.reconcile(f.context)).status).toBe("settled")
    const other = createDay1MacAppStep({...f.selected("stop"), infoPlistSha256: "f".repeat(64)}, f.runtime)
    await expect(other.reconcile(f.context)).rejects.toThrow("inputs changed during recovery")
    await release()
  }))

test("lifecycle recovery observes the completed goal without repeating an ambiguous launcher", () =>
  fixture(async (f) => {
    const step = createDay1MacAppStep(f.selected("stop"), f.runtime)
    const options: LifecycleOptions = {
      runDirectory: f.context.runDirectory,
      fixtureDirectory: join(f.folder, "fixture"),
      selection: f.context.selection,
      acquireLease: f.acquire,
      routine: {
        id: "synthetic-mac-recovery",
        definitionDigest: "synthetic-definition",
        preflight: [assertion("preflight")],
        setup: [step],
        test: [],
        finalAssertions: [assertion("final")],
        teardown: [],
        returnVerification: [assertion("return")],
        evidence: [assertion("evidence")],
      },
    }
    f.crash = true
    f.childAlive = true
    await runLifecycle(options)
    expect(launchCommands(f)).toHaveLength(1)
    f.childAlive = false
    f.app = null
    await recoverLifecycle(options)
    expect(launchCommands(f)).toHaveLength(1)
    const state = JSON.parse(await readFile(join(f.context.runDirectory, "state.json"), "utf8"))
    expect(state.operations[0].reconciliation.status).toBe("satisfied")
    expect(state.operations[0].dispatchError).toContain("synthetic interruption")
  }))

test("launcher and manifest pins are checked again even after a successful precondition", () =>
  fixture(async (f) => {
    const release = await f.acquire(),
      step = createDay1MacAppStep(f.selected("stop"), f.runtime)
    expect((await step.reconcile(f.context)).status).toBe("settled")
    const manifest = await readFile(f.base.manifest.path)
    await writeFile(f.base.manifest.path, JSON.stringify({...f.ci, build: "1"}))
    await expect(step.reconcile(f.context)).rejects.toThrow("hash")
    await writeFile(f.base.manifest.path, manifest)
    await writeFile(f.base.launcher.path, "replacement launcher")
    await expect(step.reconcile(f.context)).rejects.toThrow("hash")
    expect(launchCommands(f)).toHaveLength(0)
    await release()
  }))

test("a write-ahead intent without a child identity stays unknown even when the goal is visible", () =>
  fixture(async (f) => {
    const release = await f.acquire(),
      step = createDay1MacAppStep(f.selected("stop"), f.runtime),
      intent = f.intent("stop")
    await step.execute(f.context, intent)
    const dispatch = join(f.context.runDirectory, "day1-mac-app", f.selected("stop").id, "dispatch")
    // Simulate only the write-ahead files surviving an interruption at spawn.
    await rm(join(dispatch, "spawned.json"))
    await rm(join(dispatch, "result.json"))
    expect((await step.reconcile(f.context, intent)).status).toBe("unknown")
    await expect(step.execute(f.context, intent)).rejects.toThrow("never be repeated")
    expect(launchCommands(f)).toHaveLength(1)
    await release()
  }))

test("changing the wrapper symlink or observed process cannot satisfy the selected app proof", () =>
  fixture(async (f) => {
    const release = await f.acquire(),
      step = createDay1MacAppStep(f.selected("stop"), f.runtime)
    let calls = 0
    f.onDoctor = () => {
      if (++calls === 2) f.app = {...f.doctor, pid: 5678}
    }
    await expect(step.reconcile(f.context)).rejects.toThrow("changed during observation")
    f.onDoctor = undefined
    await rm(join(f.base.wrapperPath, "WrappedBundle"))
    await symlink(f.inner, join(f.base.wrapperPath, "WrappedBundle"))
    await expect(step.reconcile(f.context)).rejects.toThrow("wrapper layout")
    expect(launchCommands(f)).toHaveLength(0)
    await release()
  }))

async function translocated(f: Awaited<ReturnType<typeof setup>>, name: string) {
  const path = join(f.folder, name, "d", "Wrapper", "Mentra.app")
  await mkdir(join(path, ".."), {recursive: true})
  await cp(f.inner, path, {recursive: true})
  return {
    ...f.doctor,
    bundlePath: path,
    executablePath: join(path, "Mentra"),
    javascriptPath: join(path, "main.jsbundle"),
  }
}

test("a matching translocated app can stop through the installed wrapper while preserving actual running paths", () =>
  fixture(async (f) => {
    const release = await f.acquire(),
      step = createDay1MacAppStep(f.selected("stop"), f.runtime)
    f.app = await translocated(f, "AppTranslocation-first")
    const actualBundle = f.app.bundlePath
    const before = await step.reconcile(f.context)
    expect(before.status).toBe("settled")
    expect((before.actual as any).runningIdentity.bundlePath).toBe(actualBundle)
    expect((before.actual as any).installedIdentity.bundlePath).toBe(f.inner)
    const intent = f.intent("stop")
    await step.execute(f.context, intent)
    expect(launchCommands(f)[0]!.argv).toEqual([f.base.launcher.path, "--quit", f.base.wrapperPath])
    expect((await step.reconcile(f.context, intent)).status).toBe("satisfied")
    await release()
  }))

test("canonical running identity accepts /var and /private/var aliases and rejects changed translocated bytes", () =>
  fixture(async (f) => {
    const release = await f.acquire(),
      step = createDay1MacAppStep(f.selected("stop"), f.runtime)
    const app = await translocated(f, "AppTranslocation-alias")
    const alias = join(f.folder, "running-var-alias")
    await symlink(app.bundlePath, alias)
    // On macOS this also exercises the real /var -> /private/var filesystem alias.
    const actualAlias = app.bundlePath.replace(/^\/private\/var\//, "/var/")
    f.app = {...app, executablePath: join(actualAlias, "Mentra"), javascriptPath: join(alias, "main.jsbundle")}
    expect((await step.reconcile(f.context)).status).toBe("settled")
    await writeFile(join(app.bundlePath, "main.jsbundle"), "other app javascript")
    await expect(step.reconcile(f.context)).rejects.toThrow("bytes changed")
    expect(launchCommands(f)).toHaveLength(0)
    await release()
  }))

test("equal-byte running bundle changes are rejected across both observation and the final dispatch guard", () =>
  fixture(async (f) => {
    const release = await f.acquire(),
      step = createDay1MacAppStep(f.selected("stop"), f.runtime)
    const first = await translocated(f, "AppTranslocation-one"),
      second = await translocated(f, "AppTranslocation-two")
    f.app = first
    let calls = 0
    f.onDoctor = () => {
      if (++calls === 2) f.app = second
    }
    await expect(step.reconcile(f.context)).rejects.toThrow("changed during observation")
    f.app = first
    calls = 0
    f.onDoctor = () => {
      if (++calls === 3) f.app = second
    }
    await expect(step.execute(f.context, f.intent("stop"))).rejects.toThrow("changed before dispatch")
    expect(launchCommands(f)).toHaveLength(0)
    await release()
  }))
