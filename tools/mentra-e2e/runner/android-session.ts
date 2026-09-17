import {createHash, randomUUID} from "node:crypto"
import {mkdir, readFile, stat, writeFile} from "node:fs/promises"
import {join, resolve} from "node:path"

export async function androidCommand(args: string[], timeout = 20_000): Promise<Buffer> {
  const child = Bun.spawn(args, {stdout: "pipe", stderr: "pipe"})
  const timer = setTimeout(() => child.kill(), timeout)
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code) throw new Error(`${args[0]} exited ${code}: ${err.slice(-1200)}`)
    return Buffer.from(out)
  } finally {
    clearTimeout(timer)
  }
}

const unescape = (text: string) =>
  text.replace(
    /&(amp|quot|apos|lt|gt);/g,
    (_match, name: string) => ({amp: "&", quot: '"', apos: "'", lt: "<", gt: ">"})[name]!,
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
  value.replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]!)

/** One phone, one recorder, sequential semantic operations and evidence per step. */
export class AndroidSession {
  readonly directory: string
  readonly steps: AndroidStep[] = []
  private recorder?: Bun.Subprocess
  private recorderExit?: Promise<number | null>
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
  ) {
    if (!/^[A-Za-z0-9._:-]+$/.test(serial) || !/^\d+$/.test(display))
      throw new Error("Explicit phone serial and physical display ID required")
    this.directory = resolve(directory)
  }
  adb(...args: string[]) {
    return androidCommand(["adb", "-s", this.serial, ...args])
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
      const child = Bun.spawn(
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
        {
          terminal: {
            cols: 120,
            rows: 30,
            data: (_terminal, chunk) => {
              this.recordingLog += Buffer.from(chunk).toString()
              if (this.recordingLog.includes("Recording started")) {
                clearTimeout(timer)
                resolveReady()
              }
            },
          },
        },
      )
      this.recorder = child
      this.recorderExit = child.exited
      void child.exited.then(() => {
        clearTimeout(timer)
        reject(new Error("Recorder exited before readiness"))
      })
    })
    this.recordingOriginMs = (await stat(join(this.directory, "routine.mp4"))).birthtimeMs
    await this.flush("running")
  }
  async step(id: string, instruction: string, expected: string, action: () => Promise<void>) {
    if (!/^[A-Za-z0-9_-]+$/.test(id) || this.steps.some((s) => s.id === id))
      throw new Error("Step IDs must be unique safe filenames")
    const step: AndroidStep = {id, instruction, expected, startedAt: new Date().toISOString(), status: "passed"}
    this.steps.push(step)
    try {
      if (!this.recorder || this.recorder.exitCode !== null) throw new Error("Recorder is not running")
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
    step.finishedAt = new Date().toISOString()
    await this.flush("running")
    console.log(`${id}: ${step.status} — ${instruction}`)
    if (step.status === "failed") throw new Error(step.error)
  }
  async flow(id: string, commands: Record<string, unknown>[]) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Flow IDs must be safe filenames")
    const file = join(this.directory, "replay", `${id}.yaml`)
    await writeFile(
      file,
      `appId: com.mentra.mentra\n---\n${commands.map((c) => `- ${JSON.stringify(c)}`).join("\n")}\n`,
    )
    const output = await androidCommand(
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
      90_000,
    )
    await writeFile(join(this.directory, "replay", `${id}.log`), output)
  }
  async flush(status: string, extra: Record<string, unknown> = {}) {
    await writeFile(
      join(this.directory, "result.json"),
      JSON.stringify(
        {
          suite: this.suite,
          phone: this.serial,
          display: this.display,
          status,
          executionMode: this.executionMode,
          modelCalls: this.executionMode === "deterministic-replay" ? 0 : null,
          chapterTiming: "Approximate host clock relative to recorder file creation; links start 0.5 seconds early.",
          recordingOriginMs: this.recordingOriginMs,
          steps: this.steps,
          ...extra,
        },
        null,
        2,
      ) + "\n",
    )
  }
  async finish(status: "passed" | "failed", extra: Record<string, unknown> = {}) {
    // A failed start against an existing run must never rewrite its evidence.
    if (!this.ownsDirectory) return
    if (this.recorder?.pid && this.recorder.exitCode === null) {
      this.recorder.kill("SIGINT")
      const timer = setTimeout(() => {
        this.recorder?.kill("SIGKILL")
      }, 10_000)
      await this.recorderExit
      clearTimeout(timer)
    }
    this.recorder?.terminal?.close()
    await writeFile(join(this.directory, "recording.log"), this.recordingLog)
    const video = join(this.directory, "routine.mp4")
    let probe
    try {
      probe = JSON.parse(
        (
          await androidCommand(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", video])
        ).toString(),
      )
    } catch (error) {
      await this.flush("failed", {...extra, recordingError: String(error)})
      throw error
    }
    const duration = Number(probe.format.duration)
    if (!(duration > 0) || !probe.streams.some((s: {codec_type: string}) => s.codec_type === "video"))
      throw new Error("Recording has no video")
    const chapters = this.steps.map((step) => ({
      ...step,
      videoSeconds: Math.min(duration, Math.max(0, (Date.parse(step.startedAt) - this.recordingOriginMs) / 1000 - 0.5)),
    }))
    const hash = createHash("sha256")
      .update(await readFile(video))
      .digest("hex")
    await writeFile(join(this.directory, "chapters.json"), JSON.stringify(chapters, null, 2) + "\n")
    await this.flush(status, {...extra, durationSeconds: duration, videoSha256: hash})
    await writeFile(
      join(this.directory, "index.html"),
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(this.suite)}</title>
<style>body{background:#101b24;color:#eff6ff;font:16px system-ui;margin:2rem}main{display:flex;gap:2rem;align-items:flex-start}video{width:min(36vw,400px);max-height:85vh;position:sticky;top:1rem}nav{max-width:700px}button{display:block;width:100%;background:#213547;color:inherit;border:1px solid #58718a;border-radius:6px;padding:1rem;margin:.6rem 0;text-align:left;cursor:pointer}small{color:#b8c9da}a{color:#9dd4ff}img{max-height:180px}</style>
<h1>${escape(this.suite)}</h1><p>${escape(status)} · Phone ${escape(this.serial)} · ${this.executionMode === "deterministic-replay" ? "Zero model calls during replay" : "Interactive discovery; not a qualified full replay"}.</p><p>Chapter times use approximate recorder startup alignment. Each step includes its original screenshot and accessibility evidence. Hardware observations and listener checks remain separate from UI success.</p><main><video controls src="routine.mp4"></video><nav>${chapters.map((step) => `<button data-seek="${step.videoSeconds}"><b>${escape(step.id)} · ${escape(step.instruction)}</b><br><small>${escape(step.expected)} · ${escape(step.status)} · ${step.videoSeconds.toFixed(1)} s</small></button>${step.screenshot ? `<a href="${step.screenshot}">Screenshot</a> ` : ""}${step.accessibility ? `<a href="${step.accessibility}">Accessibility</a>` : ""}`).join("")}</nav></main><script>const v=document.querySelector('video');document.querySelectorAll('[data-seek]').forEach(b=>b.onclick=()=>{v.currentTime=Number(b.dataset.seek);v.play()})</script></html>`,
    )
    console.log(`Report: ${join(this.directory, "index.html")}`)
  }
}
