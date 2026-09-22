/** Direct child-process adapter. The caller retains the sole fixture lease;
 * no timeouts, kills, retries or automatic recovery writes are added here. */
import {createHash, randomUUID} from "node:crypto"
import {constants} from "node:fs"
import {lstat, mkdir, open} from "node:fs/promises"
import {dirname, isAbsolute, join, normalize} from "node:path"
import type {Day1BesCurrentState, Day1BesInputs, Day1BesRuntime, Day1BesRuntimeContext} from "./day1-bes"

const sha = /^[a-f\d]{64}$/
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
function absolute(path: string) {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || /[\0\r\n]/.test(path))
    throw new Error("BES runtime requires normalized absolute paths")
  return path
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
      throw new Error("BES runtime evidence must be a bounded private regular file")
    const bytes = await file.readFile()
    if (bytes.length > maximum) throw new Error("BES runtime evidence exceeds its size bound")
    return bytes
  } finally {
    await file.close()
  }
}

async function fileHash(path: string, executable = false) {
  const file = await open(absolute(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || (executable && !(before.mode & 0o111)))
      throw new Error("BES runtime pin is not a regular executable/file")
    const hash = createHash("sha256")
    for await (const bytes of file.createReadStream({autoClose: false})) hash.update(bytes)
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("BES runtime pin changed during verification")
    return hash.digest("hex")
  } finally {
    await file.close()
  }
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

async function privateDirectory(path: string) {
  try {
    await mkdir(path, {mode: 0o700})
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error("BES command directory must belong to the private lifecycle run")
}

/** Local trusted code only. Its inputs are pinned configuration, never CI argv. */
export function createDay1BesRuntime(inputs: Day1BesInputs): Day1BesRuntime {
  const selected = structuredClone(inputs)
  for (const path of [selected.config.path, selected.python, selected.adapterDirectory]) absolute(path)
  if (!sha.test(selected.config.sha256)) throw new Error("BES config SHA-256 is required")

  async function verifyPins() {
    const bytes = await privateBytes(selected.config.path, 65536)
    if (digest(bytes) !== selected.config.sha256) throw new Error("BES configuration changed")
    const cfg = JSON.parse(bytes.toString("utf8"))
    if (
      cfg.tools?.python?.path !== selected.python ||
      !sha.test(cfg.tools.python.sha256) ||
      (await fileHash(selected.python, true)) !== cfg.tools.python.sha256
    )
      throw new Error("BES runtime must use the pinned Python executable")
    const definition = cfg.definition
    const names = ["__init__.py", "config.py", "bes_setup.py", "run_once.py", "run.py", "reconcile.py"]
    if (!definition || Object.keys(definition).sort().join("|") !== [...names].sort().join("|"))
      throw new Error("BES adapter definition is incomplete")
    for (const name of names) {
      if (
        typeof definition[name] !== "string" ||
        !sha.test(definition[name]) ||
        (await fileHash(join(selected.adapterDirectory, name))) !== definition[name]
      )
        throw new Error("BES adapter definition changed")
    }
    const lease = JSON.parse((await privateBytes(cfg.lease?.path, 65536)).toString("utf8"))
    if (
      cfg.lease.ownerPid !== process.pid ||
      lease.pid !== process.pid ||
      typeof lease.token !== "string" ||
      !lease.token
    )
      throw new Error("BES Python must be spawned directly by the existing fixture lease owner")
  }

  async function command(bound: Day1BesRuntimeContext, argv: string[], stdin?: string) {
    if (argv[0] !== selected.python || argv.some((arg) => typeof arg !== "string" || arg.includes("\0")))
      throw new Error("BES command must use the selected Python executable")
    await verifyPins()
    const root = join(absolute(bound.lifecycle.runDirectory), "day1-bes-runtime")
    await privateDirectory(root)
    const folder = join(root, randomUUID())
    await mkdir(folder, {mode: 0o700})
    const stdoutPath = join(folder, "stdout.txt"),
      stderrPath = join(folder, "stderr.txt")
    const stdout = await open(stdoutPath, "wx", 0o600),
      stderr = await open(stderrPath, "wx", 0o600)
    const startedAt = Date.now() / 1000
    const common = {
      argv,
      startedAt,
      lifecycleOwner: bound.lifecycleOwner,
      observationOwner: bound.observationOwner,
      adapterRunDirectory: bound.adapterRunDirectory,
      configSha256: selected.config.sha256,
      automaticRetry: false,
    }
    const evidence = [join(folder, "command.json"), join(folder, "command-started.json"), stdoutPath, stderrPath]
    let exitCode: number | undefined
    let failure: string | undefined
    try {
      if (stdin !== undefined) {
        await writeOnce(join(folder, "stdin.json"), JSON.parse(stdin))
        evidence.push(join(folder, "stdin.json"))
      }
      await writeOnce(evidence[1]!, common)
      // No shell, intermediate owner, timeout, cancellation or automatic retry.
      const child = Bun.spawn(argv, {
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: stdout.fd,
        stderr: stderr.fd,
        // Execute the hashed sources, not a timestamp/size-matching stale pyc.
        env: {...process.env, PYTHONPYCACHEPREFIX: join(folder, "pycache"), PYTHONDONTWRITEBYTECODE: "1"},
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
        ...common,
        finishedAt: Date.now() / 1000,
        exitCode: exitCode ?? null,
        failure: failure ?? null,
        stdoutSha256: await fileHash(stdoutPath),
        stderrSha256: await fileHash(stderrPath),
      })
    }
    const bytes = await privateBytes(stdoutPath, 1024 * 1024)
    return {exitCode: exitCode!, stdout: bytes.toString("utf8"), evidence}
  }

  return {
    invoke: (value) => command(value, value.argv, value.stdin),
    async readCurrentState(bound) {
      const output = join(absolute(bound.lifecycle.runDirectory), `day1-bes-observation-${randomUUID()}`)
      const response = await command(bound, [
        selected.python,
        join(selected.adapterDirectory, "run.py"),
        "observe-current",
        "--config",
        selected.config.path,
        "--config-sha256",
        selected.config.sha256,
        "--owner",
        bound.observationOwner,
        "--run",
        output,
      ])
      if (response.exitCode !== 0) throw new Error(`BES current observation failed; inspect ${response.evidence[0]}`)
      const value = JSON.parse(response.stdout)
      const expected = join(output, "current.json")
      if (
        value?.status !== "observed-current" ||
        value.firmwareWrites !== 0 ||
        value.observationOwner !== bound.observationOwner ||
        value.configSha256 !== selected.config.sha256 ||
        value.run !== output ||
        value.current?.path !== expected ||
        typeof value.current.sha256 !== "string" ||
        !sha.test(value.current.sha256)
      )
        throw new Error("BES observer returned an invalid scoped reference")
      const bytes = await privateBytes(expected, 65536)
      if (digest(bytes) !== value.current.sha256) throw new Error("BES current observation changed")
      const current = JSON.parse(bytes.toString("utf8")) as Day1BesCurrentState
      if (
        current.schemaVersion !== 1 ||
        current.firmwareWrites !== 0 ||
        current.observationOwner !== bound.observationOwner ||
        current.log?.path !== join(output, "current.log") ||
        typeof current.log.sha256 !== "string" ||
        !sha.test(current.log.sha256) ||
        digest(await privateBytes(current.log.path, 20_000_000)) !== current.log.sha256
      )
        throw new Error("BES observer omitted its bound current log")
      return {
        current,
        evidence: [
          ...response.evidence,
          join(output, "result.json"),
          join(output, "owner.json"),
          join(output, "commands.jsonl"),
          expected,
          current.log.path,
        ],
      }
    },
  }
}
