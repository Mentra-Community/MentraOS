import {createInterface} from "node:readline"
import {Readable} from "node:stream"
import {bin} from "./driver"

interface VideoEvent {
  event: string
  time?: number
  duration?: number
  bytes?: number
  error?: string
}

export class Video {
  private events: VideoEvent[] = []
  private pending?: {resolve: (event: VideoEvent) => void; reject: (error: Error) => void}
  private failure?: Error
  private process: ReturnType<typeof Bun.spawn>
  private stderr: Promise<string>

  constructor(path: string) {
    this.process = Bun.spawn([bin, "--record", path], {stdin: "pipe", stdout: "pipe", stderr: "pipe"})
    this.stderr = new Response(this.process.stderr as ReadableStream).text()
    void this.read()
  }

  private async read() {
    try {
      const lines = createInterface({input: Readable.fromWeb(this.process.stdout as never)})
      for await (const line of lines) {
        const event = JSON.parse(line) as VideoEvent
        if (event.error) throw new Error(event.error)
        if (this.pending) {
          this.pending.resolve(event)
          this.pending = undefined
        } else this.events.push(event)
      }
      const code = await this.process.exited
      if (code) throw new Error(`Recorder exited ${code}: ${(await this.stderr).slice(0, 1500)}`)
      if (this.pending) throw new Error("Recorder closed before acknowledging its command")
    } catch (error) {
      this.failure = error as Error
      this.pending?.reject(this.failure)
      this.pending = undefined
    }
  }

  private async next(expected: string) {
    if (this.failure) throw this.failure
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const event =
        this.events.shift() ??
        (await new Promise<VideoEvent>((resolve, reject) => {
          this.pending = {resolve, reject}
          timer = setTimeout(() => {
            this.pending = undefined
            reject(new Error(`Recorder ${expected} timed out`))
            this.process.kill()
          }, 15000)
        }))
      if (event.event !== expected) throw new Error(`Expected recorder ${expected}, got ${event.event}`)
      return event
    } finally {
      clearTimeout(timer)
    }
  }

  async ready() {
    return this.next("ready")
  }
  async mark() {
    ;(this.process.stdin as {write: (text: string) => unknown}).write("mark\n")
    const event = await this.next("mark")
    if (typeof event.time !== "number" || !Number.isFinite(event.time))
      throw new Error("Recorder returned an invalid timestamp")
    return event.time
  }
  async reattach() {
    ;(this.process.stdin as {write: (text: string) => unknown}).write("reattach\n")
    await this.next("reattached")
  }
  async park() {
    ;(this.process.stdin as {write: (text: string) => unknown}).write("park\n")
    await this.next("parked")
  }
  async screenshot(path: string) {
    ;(this.process.stdin as {write: (text: string) => unknown}).write(`${JSON.stringify({op: "screenshot", path})}\n`)
    return (await this.next("screenshot")) as VideoEvent & {
      width: number
      height: number
      bytes: number
      frameTime: number
      observationTime: number
      observationAgeSeconds: number
      settled: boolean
    }
  }
  async stop() {
    ;(this.process.stdin as {write: (text: string) => unknown}).write("stop\n")
    const event = await this.next("finished")
    const exit = await this.process.exited
    if (exit || !event.duration || !event.bytes) throw new Error("Recording did not finalize into a nonempty video")
    return event
  }
}
