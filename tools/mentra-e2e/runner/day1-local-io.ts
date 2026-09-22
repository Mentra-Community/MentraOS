// Parameterised private evidence I/O; no command executes on import.
import {createHash, randomUUID} from "node:crypto"
import {constants} from "node:fs"
import {mkdir, open} from "node:fs/promises"
import {isAbsolute, join, normalize} from "node:path"
import {OtaCommandError} from "./ota-hardware"
import type {ReturnEvidenceRecorder, ReturnCommandCapture} from "./return-collector"
export type Ref = {path: string; sha256: string; size?: number}
export const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
export function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message)
}
export function absolute(path: string) {
  requireThat(
    typeof path === "string" && isAbsolute(path) && normalize(path) === path && !/[\0\r\n]/.test(path),
    "Normalized absolute host path required",
  )
  return path
}
export async function file(ref: Ref, maximum = 4 * 1024 * 1024, privateFile = false) {
  requireThat(/^[a-f\d]{64}$/.test(ref.sha256), "SHA256 pin required")
  const f = await open(absolute(ref.path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await f.stat()
    requireThat(
      before.isFile() &&
        before.nlink === 1 &&
        before.size <= maximum &&
        (!privateFile || (before.uid === process.getuid?.() && (before.mode & 0o777) === 0o600)),
      "Invalid pinned file",
    )
    const data = await f.readFile(),
      after = await f.stat()
    requireThat(
      data.length === before.size &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        hash(data) === ref.sha256 &&
        (ref.size === undefined || ref.size === data.length),
      "Frozen file changed",
    )
    return data
  } finally {
    await f.close()
  }
}
export async function reference(path: string) {
  const f = await open(absolute(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = await f.stat()
    requireThat(s.isFile() && s.size < 8 * 1024 * 1024, "Bounded metadata required")
    const b = await f.readFile()
    return {path, sha256: hash(b), size: b.length}
  } finally {
    await f.close()
  }
}
export async function json<T = any>(ref: Ref, privateFile = false): Promise<T> {
  return JSON.parse((await file(ref, 4 * 1024 * 1024, privateFile)).toString())
}
export class Evidence implements ReturnEvidenceRecorder {
  constructor(
    readonly output: string,
    private readonly adb: Ref,
    private readonly leasePath: string,
  ) {}
  static async create(parent: string, label: string, adb: Ref, leasePath: string) {
    const output = join(parent, `${label}-${randomUUID()}`)
    await mkdir(output, {mode: 0o700})
    return new Evidence(output, adb, leasePath)
  }
  async file(name: string, value: string | Uint8Array) {
    requireThat(/^[A-Za-z0-9_.-]+$/.test(name), "Evidence basename required")
    const path = join(this.output, name),
      f = await open(path, "wx", 0o600)
    try {
      await f.writeFile(value)
      await f.sync()
    } finally {
      await f.close()
    }
    return path
  }
  async json(name: string, value: unknown) {
    return this.file(name, JSON.stringify(value, null, 2) + "\n")
  }
  async append(value: unknown) {
    const f = await open(join(this.output, "commands.jsonl"), "a", 0o600)
    try {
      await f.write(JSON.stringify(value) + "\n")
      await f.sync()
    } finally {
      await f.close()
    }
  }
  async capture(argv: string[]): Promise<ReturnCommandCapture> {
    // This recorder serves read-only hardware observers. Firmware adapters use their own no-timeout writers.
    requireThat(argv[0] === "adb" || argv[0] === this.adb.path, "Only the pinned ADB observer is accepted")
    await file(this.adb, 64 * 1024 * 1024)
    const lease = await json(await reference(this.leasePath), true)
    requireThat(
      lease.pid === process.pid && typeof lease.token === "string" && lease.token,
      "Caller must own the live harness lease",
    )
    const id = randomUUID(),
      startedAt = new Date().toISOString(),
      actual = [this.adb.path, ...argv.slice(1)]
    await this.append({event: "read-intent", id, startedAt, argv: actual})
    const p = Bun.spawn(actual, {stdin: "ignore", stdout: "pipe", stderr: "pipe"})
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      p.kill()
    }, 10000)
    const [exitCode, stdout, stderr] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]).finally(() => clearTimeout(timer))
    requireThat(stdout.length <= 16 * 1024 * 1024 && stderr.length <= 1024 * 1024, "Observer output exceeds bound")
    await this.file(`${id}.stdout`, stdout)
    await this.file(`${id}.stderr`, stderr)
    const finishedAt = new Date().toISOString(),
      evidence = await this.json(`${id}.json`, {
        startedAt,
        finishedAt,
        argv: actual,
        exitCode,
        timedOut,
        stdoutSha256: hash(stdout),
        stderrSha256: hash(stderr),
      })
    await this.append({event: "read-result", id, evidence, exitCode, timedOut})
    if (timedOut || exitCode !== 0) throw new OtaCommandError(`Observer failed; see ${evidence}`)
    return {startedAt, finishedAt, argv: actual, exitCode, stdout: stdout.trim(), evidence}
  }
  async run(argv: string[]) {
    return (await this.capture(argv)).stdout
  }
}
