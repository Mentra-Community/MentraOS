import {createHash, randomUUID} from "node:crypto"
import {mkdir, readFile, stat, writeFile} from "node:fs/promises"
import {join, resolve} from "node:path"
import {stopOwnedProcess} from "./owned-process"

export async function androidCommand(args: string[], timeout = 20_000): Promise<Buffer> {
  const child = Bun.spawn(args, {stdout: "pipe", stderr: "pipe"})
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeout)
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (timedOut) throw new Error(`${args[0]} exceeded ${timeout} ms`)
    if (code) throw new Error(`${args[0]} exited ${code}: ${err.slice(-1200)}`)
    return Buffer.from(out)
  } finally {
    clearTimeout(timer)
  }
}

type Recorder = Pick<Bun.Subprocess, "pid" | "exitCode" | "signalCode" | "exited" | "kill" | "terminal">
const androidRuntime = {
  command: androidCommand,
  startRecorder: (args: string[], onData: (chunk: Uint8Array) => void): Recorder =>
    Bun.spawn(args, {terminal: {cols: 120, rows: 30, data: (_terminal, chunk) => onData(chunk)}}),
}

const unescape = (text: string) =>
  text.replace(
    /&(amp|quot|apos|lt|gt);/g,
    (_match, name: string) => ({amp: "&", quot: '"', apos: "'", lt: "<", gt: ">"}[name]!),
  )
export function androidNodes(xml: string) {
  if (!xml.includes("<hierarchy") || !xml.includes("</hierarchy>"))
    throw new Error("Incomplete Android accessibility dump")
  return [...xml.matchAll(/<node\b[^>]*>/g)].map(([tag]) => {
    const attributes = Object.fromEntries(
      [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)]),
    )
    return {
      text: attributes.text || "",
      description: attributes["content-desc"] || "",
      id: attributes["resource-id"] || "",
    }
  })
}

export type AndroidStep = {
  id: string
  instruction: string
  expected: string
  status: "passed" | "failed" | "not-run"
  startedAt: string
  finishedAt?: string
  screenshot?: string
  accessibility?: string
  error?: string
}
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]!))

/** One phone, one recorder, sequential semantic operations and evidence per step. */
export class AndroidSession {
  readonly directory: string
  readonly steps: AndroidStep[] = []
  private recorder?: Recorder
  private recorderStopRequested = false
  private recordingFailure?: string
  private recordingLog = ""
  private recordingOriginMs = 0
  private dimensions?: string
  private ownsDirectory = false
  constructor(
    readonly serial: string,
    readonly display: string,
    readonly suite: string,
    directory: string,
    readonly executionMode: "deterministic-replay" | "interactive-discovery" = "deterministic-replay",
    private readonly runtime = androidRuntime,
  ) {
    if (!/^[A-Za-z0-9._:-]+$/.test(serial) || !/^\d+$/.test(display))
      throw new Error("Explicit phone serial and physical display ID required")
    this.directory = resolve(directory)
  }
  adb(...args: string[]) {
    return this.runtime.command(["adb", "-s", this.serial, ...args])
  }
  async snapshot() {
    const remote = `/sdcard/mentra-e2e-${randomUUID()}.xml`
    try {
      await this.adb("shell", "uiautomator", "dump", remote)
      const xml = (await this.adb("exec-out", "cat", remote)).toString()
      return {xml, nodes: androidNodes(xml)}
    } finally {
      await this.adb("shell", "rm", "-f", remote).catch(() => {})
    }
  }
  async start() {
    await mkdir(this.directory, {recursive: false, mode: 0o700})
    this.ownsDirectory = true
    await mkdir(join(this.directory, "screenshots"))
    await mkdir(join(this.directory, "accessibility"))
    await mkdir(join(this.directory, "replay"))
    if ((await this.adb("get-state")).toString().trim() !== "device") throw new Error("Phone is unavailable")
    // A private PTY makes scrcpy flush readiness without opening a Mac window.
    // Signals target this owned process only, never the global ADB server.
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("Android recorder readiness timed out")), 20_000)
      const child = this.runtime.startRecorder(
        [
          "scrcpy",
          "--serial",
          this.serial,
          "--no-window",
          "--no-control",
          "--no-audio",
          "--time-limit=1800",
          "--record",
          join(this.directory, "routine.mp4"),
        ],
        (chunk) => {
          this.recordingLog += Buffer.from(chunk).toString()
          if (this.recordingLog.includes("Recording started")) {
            clearTimeout(timer)
            resolveReady()
          }
        },
      )
      this.recorder = child
      void child.exited.then((code) => {
        if (!this.recorderStopRequested)
          this.recordingFailure = `Recorder exited unexpectedly (${code}, ${child.signalCode})`
        clearTimeout(timer)
        reject(new Error("Recorder exited before readiness"))
      })
    })
    this.recordingOriginMs = (await stat(join(this.directory, "routine.mp4"))).birthtimeMs
    await this.flush("running")
  }
  private requireRecorder() {
    if (this.recordingFailure) throw new Error(this.recordingFailure)
    if (!this.recorder || this.recorder.exitCode !== null || this.recorder.signalCode !== null)
      throw new Error("Recorder is not running")
  }
  async step(id: string, instruction: string, expected: string, action: () => Promise<void>) {
    if (!/^[A-Za-z0-9_-]+$/.test(id) || this.steps.some((s) => s.id === id))
      throw new Error("Step IDs must be unique safe filenames")
    const step: AndroidStep = {id, instruction, expected, startedAt: new Date().toISOString(), status: "passed"}
    this.steps.push(step)
    try {
      this.requireRecorder()
      await action()
    } catch (error) {
      step.status = "failed"
      step.error = String(error)
    }
    try {
      const state = await this.snapshot()
      step.accessibility = `accessibility/${id}.xml`
      await writeFile(join(this.directory, step.accessibility), state.xml)
      const png = await this.adb("exec-out", "screencap", "-p", "-d", this.display)
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error("Invalid phone screenshot")
      const dimensions = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`
      if (this.dimensions && this.dimensions !== dimensions) throw new Error("Phone viewport changed during the run")
      this.dimensions = dimensions
      step.screenshot = `screenshots/${id}.png`
      await writeFile(join(this.directory, step.screenshot), png)
    } catch (error) {
      step.status = "failed"
      step.error = [step.error, String(error)].filter(Boolean).join("; ")
    }
    try {
      this.requireRecorder()
    } catch (error) {
      step.status = "failed"
      step.error = [step.error, String(error)].filter(Boolean).join("; ")
    }
    step.finishedAt = new Date().toISOString()
    await this.flush("running")
    console.log(`${id}: ${step.status} — ${instruction}`)
    if (step.status === "failed") throw new Error(step.error)
  }
  async flow(id: string, commands: Record<string, unknown>[], timeoutMs = 90_000) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Flow IDs must be safe filenames")
    const file = join(this.directory, "replay", `${id}.yaml`)
    await writeFile(
      file,
      `appId: com.mentra.mentra\n---\n${commands.map((c) => `- ${JSON.stringify(c)}`).join("\n")}\n`,
    )
    const output = await this.runtime.command(
      [
        "maestro",
        "--device",
        this.serial,
        "test",
        "--test-output-dir",
        join(this.directory, "maestro"),
        "--debug-output",
        join(this.directory, "maestro"),
        file,
      ],
      timeoutMs,
    )
    await writeFile(join(this.directory, "replay", `${id}.log`), output)
  }
  async flush(status: string, extra: Record<string, unknown> = {}) {
    await writeFile(
      join(this.directory, "result.json"),
      JSON.stringify(
        {
          ...extra,
          suite: this.suite,
          phone: this.serial,
          display: this.display,
          status,
          executionMode: this.executionMode,
          modelCalls: this.executionMode === "deterministic-replay" ? 0 : null,
          chapterTiming: "Approximate host clock relative to recorder file creation; links start 0.5 seconds early.",
          recordingOriginMs: this.recordingOriginMs,
          steps: this.steps,
        },
        null,
        2,
      ) + "\n",
    )
  }
  async finish(status: "passed" | "failed", extra: Record<string, unknown> = {}) {
    // A failed start against an existing run must never rewrite its evidence.
    if (!this.ownsDirectory) return
    const errors: string[] = []
    try {
      this.requireRecorder()
    } catch (error) {
      errors.push(String(error))
    }
    this.recorderStopRequested = true
    if (this.recorder) {
      try {
        await stopOwnedProcess(this.recorder, "SIGINT", 10_000)
        if (this.recorder.exitCode !== 0 && this.recorder.signalCode !== "SIGINT")
          throw new Error(`Recorder finalization exited ${this.recorder.exitCode}`)
      } catch (error) {
        errors.push(String(error))
      } finally {
        this.recorder.terminal?.close()
      }
    }
    if (this.recordingFailure) errors.push(this.recordingFailure)
    await writeFile(join(this.directory, "recording.log"), this.recordingLog)
    const video = join(this.directory, "routine.mp4")
    let duration: number | undefined
    let hash: string | undefined
    const requiredDuration = Math.max(
      0,
      ...this.steps.map((step) => (Date.parse(step.finishedAt ?? step.startedAt) - this.recordingOriginMs) / 1000),
    )
    try {
      const probe = JSON.parse(
        (
          await this.runtime.command(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", video])
        ).toString(),
      )
      duration = Number(probe.format.duration)
      if (
        !Number.isFinite(duration) ||
        !(duration > 0) ||
        !probe.streams.some((s: {codec_type: string}) => s.codec_type === "video")
      )
        throw new Error("Recording has no video")
      hash = createHash("sha256")
        .update(await readFile(video))
        .digest("hex")
      // File creation/host clocks are approximate. A one-second alignment
      // allowance cannot excuse an early recorder exit (checked separately).
      if (!this.recordingOriginMs || duration + 1 < requiredDuration)
        throw new Error(`Recording ends at ${duration}s before the routine ends at ${requiredDuration}s`)
    } catch (error) {
      errors.push(String(error))
    }
    if (errors.length || !this.steps.length || this.steps.some((step) => step.status !== "passed")) status = "failed"
    const chapters = this.steps.map((step) => ({
      ...step,
      videoSeconds: Math.max(0, (Date.parse(step.startedAt) - this.recordingOriginMs) / 1000 - 0.5),
    }))
    await writeFile(join(this.directory, "chapters.json"), JSON.stringify(chapters, null, 2) + "\n")
    await this.flush(status, {
      ...extra,
      durationSeconds: duration,
      videoSha256: hash,
      requiredDurationSeconds: requiredDuration,
      recordingCoverageToleranceSeconds: 1,
      recordingError: errors.join("; ") || undefined,
    })
    await writeFile(
      join(this.directory, "index.html"),
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(this.suite)}</title>
<style>body{background:#101b24;color:#eff6ff;font:16px system-ui;margin:2rem}main{display:flex;gap:2rem;align-items:flex-start}video{width:min(36vw,400px);max-height:85vh;position:sticky;top:1rem}nav{max-width:700px}button{display:block;width:100%;background:#213547;color:inherit;border:1px solid #58718a;border-radius:6px;padding:1rem;margin:.6rem 0;text-align:left;cursor:pointer}small{color:#b8c9da}a{color:#9dd4ff}img{max-height:180px}</style>
<h1>${escape(this.suite)}</h1><p>${escape(status)} · Phone ${escape(this.serial)} · ${
        this.executionMode === "deterministic-replay"
          ? "Zero model calls during replay"
          : "Interactive discovery; not a qualified full replay"
      }.</p><p>Chapter times use approximate recorder startup alignment. Each step includes its original screenshot and accessibility evidence. Hardware observations and listener checks remain separate from UI success.</p><main><video controls src="routine.mp4"></video><nav>${chapters
        .map(
          (step) =>
            `<button data-seek="${step.videoSeconds}"><b>${escape(step.id)} · ${escape(
              step.instruction,
            )}</b><br><small>${escape(step.expected)} · ${escape(step.status)} · ${step.videoSeconds.toFixed(
              1,
            )} s</small></button>${step.screenshot ? `<a href="${step.screenshot}">Screenshot</a> ` : ""}${
              step.accessibility ? `<a href="${step.accessibility}">Accessibility</a>` : ""
            }`,
        )
        .join(
          "",
        )}</nav></main><script>const v=document.querySelector('video');document.querySelectorAll('[data-seek]').forEach(b=>b.onclick=()=>{v.currentTime=Number(b.dataset.seek);v.play()})</script></html>`,
    )
    console.log(`Report: ${join(this.directory, "index.html")}`)
    if (errors.length) throw new Error(errors.join("; "))
    if (status !== "passed") throw new Error("Android routine failed; see recorded evidence")
    return status
  }
}
