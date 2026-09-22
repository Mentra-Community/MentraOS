/** Direct child-process runtime for the existing January lifecycle steps.
 * The caller owns the lease. No timeouts, process kills, retries or firmware
 * selection are added here; raw command evidence remains private. */
import {createHash, randomUUID} from "node:crypto"
import {constants} from "node:fs"
import {mkdir, open} from "node:fs/promises"
import {dirname, isAbsolute, join, normalize} from "node:path"
import type {
  Day1FullOtaCurrentState,
  Day1FullOtaInputs,
  Day1FullOtaRuntime,
  Day1FullOtaRuntimeContext,
} from "./day1-full-ota"

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
function absolute(value: string) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || /[\0\r\n]/.test(value))
    throw new Error("January runtime requires normalized absolute paths")
  return value
}
async function writeOnce(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600)
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n")
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
async function privateBytes(path: string, maximum: number) {
  const file = await open(absolute(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > maximum
    )
      throw new Error("January runtime evidence must be a bounded private regular file")
    const bytes = await file.readFile()
    if (bytes.length > maximum) throw new Error("January runtime evidence exceeds the size bound")
    return bytes
  } finally {
    await file.close()
  }
}

/** stageMissingProbe authorizes only the pinned diagnostic JAR, with its own
 * identity-bound intent/claim. It does not authorize another firmware dispatch. */
export function createDay1FullOtaRuntime(
  inputs: Day1FullOtaInputs,
  options: {stageMissingProbe?: boolean} = {},
): Day1FullOtaRuntime {
  const selected = structuredClone(inputs)
  for (const path of [selected.config.path, selected.python, selected.adapterDirectory]) absolute(path)
  if (!/^[a-f\d]{64}$/.test(selected.config.sha256)) throw new Error("January config SHA-256 is required")
  const stageMissingProbe = options.stageMissingProbe === true

  async function command(bound: Day1FullOtaRuntimeContext, argv: string[], stdin?: string) {
    if (argv[0] !== selected.python || argv.some((arg) => typeof arg !== "string" || arg.includes("\0")))
      throw new Error("January runtime command must use the selected Python executable")
    const cfgBytes = await privateBytes(selected.config.path, 65536)
    if (hash(cfgBytes) !== selected.config.sha256) throw new Error("January configuration changed")
    const folder = join(absolute(bound.lifecycle.runDirectory), "day1-full-ota-runtime", randomUUID())
    await mkdir(folder, {recursive: true, mode: 0o700})
    const stdoutPath = join(folder, "stdout.txt")
    const stderrPath = join(folder, "stderr.txt")
    const stdout = await open(stdoutPath, "wx", 0o600)
    const stderr = await open(stderrPath, "wx", 0o600)
    const evidence = [join(folder, "command.json"), stdoutPath, stderrPath]
    if (stdin !== undefined) {
      await writeOnce(join(folder, "stdin.json"), JSON.parse(stdin))
      evidence.push(join(folder, "stdin.json"))
    }
    const startedAt = Date.now() / 1000
    const startedPath = join(folder, "command-started.json")
    await writeOnce(startedPath, {
      argv,
      startedAt,
      phase: bound.phase,
      stageOwner: bound.stageOwner,
      adapterRunDirectory: bound.adapterRunDirectory,
      configSha256: selected.config.sha256,
      automaticRetry: false,
    })
    evidence.push(startedPath)
    let exitCode: number | undefined
    let failure: string | undefined
    try {
      // Directly spawned by the existing lease owner. No shell or intermediate worker.
      const child = Bun.spawn(argv, {
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: stdout.fd,
        stderr: stderr.fd,
      })
      exitCode = await child.exited
    } catch (error) {
      failure = error instanceof Error ? error.name : "UnknownError"
      throw error
    } finally {
      await stdout.sync()
      await stderr.sync()
      await stdout.close()
      await stderr.close()
      await writeOnce(evidence[0]!, {
        argv,
        startedAt,
        finishedAt: Date.now() / 1000,
        phase: bound.phase,
        stageOwner: bound.stageOwner,
        adapterRunDirectory: bound.adapterRunDirectory,
        configSha256: selected.config.sha256,
        exitCode: exitCode ?? null,
        failure: failure ?? null,
        automaticRetry: false,
      })
    }
    const bytes = await privateBytes(stdoutPath, 1024 * 1024)
    return {exitCode: exitCode!, stdout: bytes.toString("utf8"), evidence, folder}
  }

  return {
    invoke: async (value) => command(value, value.argv, value.stdin),
    async readCurrentState(bound) {
      // The observation output is a sibling, leaving the pre-stage path absent.
      const observerOutput = join(absolute(bound.lifecycle.runDirectory), `day1-observation-${randomUUID()}`)
      const response = await command(bound, [
        selected.python,
        join(selected.adapterDirectory, "full_january.py"),
        "observe",
        "--config",
        selected.config.path,
        "--config-sha256",
        selected.config.sha256,
        "--run",
        absolute(bound.adapterRunDirectory),
        "--out",
        observerOutput,
        ...(stageMissingProbe ? ["--stage-missing-probe"] : []),
      ])
      if (response.exitCode !== 0)
        throw new Error(`January current observation failed; inspect ${response.evidence[0]}`)
      const result = JSON.parse(response.stdout)
      const expected = join(observerOutput, "current.json")
      if (
        result?.firmwareWrites !== 0 ||
        result.current?.path !== expected ||
        !/^[a-f\d]{64}$/.test(result.current.sha256)
      )
        throw new Error("January observer returned an invalid scoped reference")
      const bytes = await privateBytes(expected, 8 * 1024 * 1024)
      if (hash(bytes) !== result.current.sha256) throw new Error("January current observation changed")
      const current = JSON.parse(bytes.toString("utf8")) as Day1FullOtaCurrentState & {firmwareWrites?: number}
      if (current.firmwareWrites !== 0 || typeof current.engineStatus !== "string")
        throw new Error("January observer omitted its actual engine result")
      return {current, evidence: [...response.evidence, observerOutput, expected]}
    },
  }
}
