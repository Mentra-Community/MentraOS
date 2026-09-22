/** Normal stop/start of the already installed, verified Mac wrapper. The caller
 * owns the fixture lease and lifecycle journal; this adapter never installs,
 * replaces, force-quits, retries or requests foreground activation. */
import {createHash, randomUUID} from "node:crypto"
import {constants} from "node:fs"
import {lstat, mkdir, open, readlink, realpath} from "node:fs/promises"
import {dirname, isAbsolute, join, normalize} from "node:path"
import {isDeepStrictEqual} from "node:util"
import {verifyBuildManifest} from "./build-manifest"
import type {Doctor} from "./driver"
import type {Json, LifecycleContext, MutationIntent, MutationStep, Reconciliation} from "./lifecycle"

type Pin = {path: string; sha256: string}
export interface Day1MacAppInputs {
  id: string
  action: "stop" | "launch"
  phase: "setup" | "teardown"
  manifest: Pin
  launcher: Pin
  driver: Pin
  wrapperPath: string
  infoPlistSha256: string
  leasePath: string
}

/** Test seam only: production directly spawns pinned executables. No command or
 * path is taken from a CI request, app response, or reconciliation receipt. */
export interface Day1MacAppProcesses {
  spawn(command: {argv: string[]; stdin?: string; stdout: number; stderr: number}): {
    pid: number
    exited: Promise<number>
  }
  isAlive(pid: number): boolean
}
const processes: Day1MacAppProcesses = {
  spawn: ({argv, stdin, stdout, stderr}) =>
    Bun.spawn(argv, {stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout, stderr}),
  isAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
      throw error
    }
  },
}
const sha = /^[a-f0-9]{64}$/
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/
const bundleID = "com.mentra.mentra"
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value))
function absolute(value: string) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || /[\0\r\n]/.test(value))
    throw new Error("Mac app paths must be normalized and absolute")
  return value
}
async function bytes(path: string, privateFile = false) {
  const file = await open(absolute(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.size > 1024 * 1024 ||
      (privateFile && (stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600))
    )
      throw new Error("Expected a bounded regular file with the required privacy")
    return await file.readFile()
  } finally {
    await file.close()
  }
}
async function hashFile(path: string) {
  if ((await realpath(absolute(path))) !== path) throw new Error("Pinned app files must not traverse symlinks")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile()) throw new Error("Pinned app input is not a regular file")
    const hash = createHash("sha256")
    for await (const chunk of file.createReadStream({autoClose: false})) hash.update(chunk)
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("App input changed while hashing")
    return hash.digest("hex")
  } finally {
    await file.close()
  }
}
async function writeOnce(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600)
  try {
    await file.writeFile(value instanceof Uint8Array ? value : JSON.stringify(value, null, 2) + "\n")
    await file.sync()
  } finally {
    await file.close()
  }
  const parent = await open(dirname(path), "r")
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
}
async function optional(path: string) {
  try {
    return JSON.parse((await bytes(path, true)).toString("utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** Caller supplies separate IDs for setup stop, setup launch and an optional
 * teardown launch. An already-correct goal is observed without calling the
 * launcher; an ambiguous dispatch is never sent again. */
export function createDay1MacAppStep(inputs: Day1MacAppInputs, runtime: Day1MacAppProcesses = processes): MutationStep {
  const selected = structuredClone(inputs)
  if (
    !/^[a-z][a-z0-9-]{0,79}$/.test(selected.id) ||
    !["stop", "launch"].includes(selected.action) ||
    !["setup", "teardown"].includes(selected.phase)
  )
    throw new Error("Invalid Mac app lifecycle step")
  for (const pin of [selected.manifest, selected.launcher, selected.driver]) {
    absolute(pin.path)
    if (!sha.test(pin.sha256)) throw new Error("Mac app file SHA-256 is required")
  }
  absolute(selected.wrapperPath)
  absolute(selected.leasePath)
  if (!sha.test(selected.infoPlistSha256)) throw new Error("Wrapper Info.plist SHA-256 is required")
  const inputsSha256 = digest(JSON.stringify(selected))
  const inner = join(selected.wrapperPath, "Wrapper", "Mentra.app")
  const plist = join(inner, "Info.plist")
  const argv =
    selected.action === "stop"
      ? [selected.launcher.path, "--quit", selected.wrapperPath]
      : [selected.launcher.path, selected.wrapperPath]

  function bound(context: LifecycleContext, intent?: Readonly<MutationIntent>) {
    const matches = context.operations.filter((item) => item.stepID === selected.id)
    if (
      matches.length > 1 ||
      (matches.length && !intent) ||
      (intent &&
        (matches[0]?.operationID !== intent.operationID ||
          !uuid.test(intent.operationID) ||
          intent.stepID !== selected.id ||
          intent.phase !== selected.phase ||
          matches[0]?.phase !== selected.phase))
    )
      throw new Error("Mac app command requires its matching durable lifecycle intent")
    return {
      folder: join(absolute(context.runDirectory), "day1-mac-app", selected.id),
      owner: intent?.operationID ?? null,
    }
  }
  async function lease() {
    const value = JSON.parse((await bytes(selected.leasePath, true)).toString("utf8"))
    if (value.pid !== process.pid || typeof value.token !== "string" || !value.token)
      throw new Error("Mac app commands require the caller's current live fixture lease")
  }
  async function pin(ref: Pin, executable = false) {
    if ((await hashFile(ref.path)) !== ref.sha256 || (executable && !((await lstat(ref.path)).mode & 0o111)))
      throw new Error("Selected Mac app input hash or executable mode changed")
  }
  async function command(folder: string, commandArgv: string[], owner: string | null, stdin?: string) {
    await lease()
    await mkdir(folder, {mode: 0o700})
    const stdout = await open(join(folder, "stdout.txt"), "wx", 0o600)
    const stderr = await open(join(folder, "stderr.txt"), "wx", 0o600)
    const start = {argv: commandArgv, stdin: stdin ?? null, owner, inputsSha256, startedAt: Date.now() / 1000}
    await writeOnce(join(folder, "started.json"), start)
    let exitCode: number | null = null
    let failure: string | null = null
    try {
      const child = runtime.spawn({argv: commandArgv, stdin, stdout: stdout.fd, stderr: stderr.fd})
      const completion = child.exited.then(
        (code) => ({code, error: undefined}),
        (error) => ({code: null, error}),
      )
      if (!Number.isSafeInteger(child.pid) || child.pid < 2) throw new Error("Invalid child process identity")
      await writeOnce(join(folder, "spawned.json"), {...start, pid: child.pid})
      const completed = await completion
      if (completed.error !== undefined) throw completed.error
      exitCode = completed.code
      if (!Number.isInteger(exitCode)) throw new Error("Missing command exit status")
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      await stdout.sync()
      await stderr.sync()
      await stdout.close()
      await stderr.close()
      await writeOnce(join(folder, "result.json"), {...start, finishedAt: Date.now() / 1000, exitCode, failure})
    }
    return {
      exitCode,
      stdout: (await bytes(join(folder, "stdout.txt"), true)).toString("utf8"),
      evidence: [
        join(folder, "started.json"),
        join(folder, "spawned.json"),
        join(folder, "result.json"),
        join(folder, "stdout.txt"),
        join(folder, "stderr.txt"),
      ],
    }
  }
  async function prepare(folder: string, owner: string | null, evidence: string[]) {
    await lease()
    await mkdir(folder, {recursive: true, mode: 0o700})
    const frozen = join(folder, "inputs.json")
    const old = await optional(frozen)
    if (old === undefined) await writeOnce(frozen, selected)
    else if (!isDeepStrictEqual(old, selected)) throw new Error("Mac app step inputs changed during recovery")
    evidence.push(frozen)
    for (const ref of [selected.manifest, selected.launcher, selected.driver]) await pin(ref, ref !== selected.manifest)
    if (
      (await realpath(selected.wrapperPath)) !== selected.wrapperPath ||
      !(await lstat(selected.wrapperPath)).isDirectory() ||
      (await readlink(join(selected.wrapperPath, "WrappedBundle"))) !== "Wrapper/Mentra.app" ||
      (await realpath(join(selected.wrapperPath, "WrappedBundle"))) !== inner
    )
      throw new Error("Expected the installed managed Mentra wrapper layout")
    await pin({path: plist, sha256: selected.infoPlistSha256})
    const manifestBytes = await bytes(selected.manifest.path)
    if (digest(manifestBytes) !== selected.manifest.sha256) throw new Error("Build manifest changed")
    const manifestPath = join(folder, "build-manifest.json")
    try {
      await writeOnce(manifestPath, manifestBytes)
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        digest(await bytes(manifestPath, true)) !== selected.manifest.sha256
      )
        throw error
    }
    evidence.push(manifestPath)
    const manifest = JSON.parse(manifestBytes.toString("utf8"))
    const result = await command(
      join(folder, `plist-${randomUUID()}`),
      ["/usr/bin/plutil", "-convert", "json", "-o", "-", plist],
      owner,
    )
    evidence.push(...result.evidence)
    if (result.exitCode !== 0) throw new Error("Could not read wrapper Info.plist")
    const info = JSON.parse(result.stdout)
    if (
      info.CFBundleIdentifier !== bundleID ||
      typeof info.CFBundleExecutable !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(info.CFBundleExecutable) ||
      [".", ".."].includes(info.CFBundleExecutable) ||
      typeof info.CFBundleShortVersionString !== "string" ||
      typeof info.CFBundleVersion !== "string"
    )
      throw new Error("Unexpected installed wrapper identity")
    const identity = {
      bundleId: bundleID,
      bundlePath: inner,
      executablePath: join(inner, info.CFBundleExecutable),
      javascriptPath: join(inner, "main.jsbundle"),
      version: info.CFBundleShortVersionString,
      build: info.CFBundleVersion,
    }
    const hashes = {
      executableSha256: await hashFile(identity.executablePath),
      javascriptSha256: await hashFile(identity.javascriptPath),
    }
    const provenance = verifyBuildManifest(manifest, {...identity, ...hashes})
    // Older local manifests may omit version/build. When supplied, they remain binding.
    if (
      (manifest.version !== undefined && manifest.version !== identity.version) ||
      (manifest.build !== undefined && manifest.build !== identity.build)
    )
      throw new Error("Local app version/build changed")
    await pin({path: plist, sha256: selected.infoPlistSha256})
    return {identity, hashes, provenance}
  }
  async function doctor(folder: string, owner: string | null, evidence: string[]) {
    await pin(selected.driver, true)
    const result = await command(
      join(folder, `doctor-${randomUUID()}`),
      [selected.driver.path],
      owner,
      JSON.stringify({op: "doctor", bundleId: bundleID}),
    )
    evidence.push(...result.evidence)
    const value = JSON.parse(result.stdout)
    if (
      result.exitCode === 1 &&
      value.ok === false &&
      value.error === `Expected one running ${bundleID} process, found 0`
    )
      return null
    if (
      result.exitCode !== 0 ||
      value.ok !== true ||
      !value.result ||
      !Number.isSafeInteger(value.result.pid) ||
      value.result.pid < 2
    )
      throw new Error("Could not establish a single selected app or its absence")
    return value.result as Doctor
  }
  async function runningIdentity(
    value: Doctor | null,
    prepared: Awaited<ReturnType<typeof prepare>>,
    verifyBytes = false,
  ) {
    if (!value) return null
    for (const key of ["bundleId", "version", "build"] as const)
      if (value[key] !== prepared.identity[key])
        throw new Error("Running app differs from the selected installed wrapper")
    // App Translocation and /var -> /private/var aliases are legitimate. Bind
    // the actual canonical running bundle, not the installation's pathname.
    const bundlePath = await realpath(absolute(value.bundlePath))
    const executablePath = await realpath(absolute(value.executablePath))
    const javascriptPath = await realpath(absolute(value.javascriptPath))
    if (
      !(await lstat(bundlePath)).isDirectory() ||
      !executablePath.startsWith(bundlePath + "/") ||
      !javascriptPath.startsWith(bundlePath + "/")
    )
      throw new Error("Running app bytes must be contained in its actual bundle")
    if (
      verifyBytes &&
      ((await hashFile(executablePath)) !== prepared.hashes.executableSha256 ||
        (await hashFile(javascriptPath)) !== prepared.hashes.javascriptSha256)
    )
      throw new Error("Running app bytes changed")
    return {
      pid: value.pid,
      bundleId: value.bundleId,
      version: value.version,
      build: value.build,
      bundlePath,
      executablePath,
      javascriptPath,
    }
  }
  async function observe(folder: string, owner: string | null, evidence: string[]) {
    const prepared = await prepare(folder, owner, evidence)
    const first = await runningIdentity(await doctor(folder, owner, evidence), prepared, true)
    const last = await runningIdentity(await doctor(folder, owner, evidence), prepared)
    if (!isDeepStrictEqual(first, last)) throw new Error("App identity/process changed during observation")
    return {
      state: last ? ("running" as const) : ("absent" as const),
      pid: last?.pid ?? null,
      ...prepared,
      installedIdentity: prepared.identity,
      runningIdentity: last,
    }
  }
  function goal(state: "running" | "absent") {
    return state === (selected.action === "stop" ? "absent" : "running")
  }
  async function dispatchState(folder: string, owner: string | null) {
    const receipt = await optional(join(folder, "dispatch-intent.json"))
    if (!receipt) return {status: "none" as const, evidence: [] as string[]}
    if (
      !owner ||
      receipt.owner !== owner ||
      receipt.inputsSha256 !== inputsSha256 ||
      !isDeepStrictEqual(receipt.argv, argv)
    )
      throw new Error("Mac app dispatch identity mismatch")
    const evidence = [join(folder, "dispatch-intent.json")]
    const result = await optional(join(folder, "dispatch", "result.json"))
    const spawned = await optional(join(folder, "dispatch", "spawned.json"))
    for (const value of [result, spawned].filter(Boolean))
      if (value.owner !== owner || value.inputsSha256 !== inputsSha256 || !isDeepStrictEqual(value.argv, argv))
        throw new Error("Mac app command receipt mismatch")
    if (result) evidence.push(join(folder, "dispatch", "result.json"))
    if (spawned) evidence.push(join(folder, "dispatch", "spawned.json"))
    if (result && Number.isInteger(result.exitCode)) return {status: "exited" as const, evidence}
    if (spawned && Number.isSafeInteger(spawned.pid) && spawned.pid > 1)
      return {status: runtime.isAlive(spawned.pid) ? ("active" as const) : ("exited" as const), evidence}
    return {status: "unknown" as const, evidence}
  }
  return {
    id: selected.id,
    kind: "mutation",
    repeat: "never",
    instruction:
      selected.action === "stop"
        ? "Stop the verified Mentra App through normal termination before firmware work."
        : "Launch the verified Mentra App only when it is absent, without foreground activation.",
    async execute(context, intent): Promise<Json> {
      const {folder, owner} = bound(context, intent)
      const evidence: string[] = []
      if (await optional(join(folder, "dispatch-intent.json")))
        throw new Error("Mac app dispatch must never be repeated")
      const current = await observe(folder, owner, evidence)
      if (goal(current.state)) return {dispatched: false, reason: "already_at_goal", evidence}
      await pin(selected.launcher, true)
      await lease()
      // The caller's single lease covers the final observation and this normal
      // launcher call. External user launches cannot be made atomic by this API.
      const fresh = await runningIdentity(await doctor(folder, owner, evidence), current)
      if (!isDeepStrictEqual(fresh, current.runningIdentity)) throw new Error("App process changed before dispatch")
      await writeOnce(join(folder, "dispatch-intent.json"), {
        owner,
        inputsSha256,
        argv,
        observed: current,
        intendedAt: Date.now() / 1000,
        automaticRetry: false,
      })
      const response = await command(join(folder, "dispatch"), argv, owner)
      return {
        owner,
        action: selected.action,
        inputsSha256,
        exitCode: response.exitCode,
        evidence: [...evidence, join(folder, "dispatch-intent.json"), ...response.evidence],
      }
    },
    async reconcile(context, intent): Promise<Reconciliation> {
      const {folder, owner} = bound(context, intent)
      const evidence: string[] = []
      const current = await observe(folder, owner, evidence)
      const dispatch = await dispatchState(folder, owner)
      evidence.push(...dispatch.evidence)
      const status =
        dispatch.status === "active"
          ? "active"
          : dispatch.status === "unknown"
            ? "unknown"
            : goal(current.state)
              ? "satisfied"
              : intent
                ? "unknown"
                : "settled"
      const result: Reconciliation = {
        status,
        expected: {action: selected.action, bundleId: bundleID, wrapperPath: selected.wrapperPath, inputsSha256},
        actual: json({owner, ...current, dispatchState: dispatch.status}),
        observedAt: new Date().toISOString(),
        source: "Pinned native doctor + installed wrapper binary/JavaScript hashes",
        evidence,
        identity: json(current.runningIdentity ?? current.identity),
      }
      const path = join(folder, `observation-${randomUUID()}.json`)
      await writeOnce(path, result)
      result.evidence.push(path)
      return result
    },
  }
}
