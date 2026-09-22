import {appendFile, writeFile} from "node:fs/promises"
import {join} from "node:path"
import type {ReturnCommandCapture, ReturnEvidenceRecorder} from "./return-collector"

/** Offline test adapter only. No subprocess or device command is executed. */
export class TestReturnRecorder implements ReturnEvidenceRecorder {
  readonly commands: string[][] = []
  constructor(
    readonly output: string,
    readonly respond: (argv: string[]) => Promise<string> | string = () => {
      throw new Error("Unexpected command")
    },
  ) {}
  async file(name: string, value: string | Uint8Array) {
    const path = join(this.output, name)
    await writeFile(path, value, {flag: "wx", mode: 0o600})
    return path
  }
  async json(name: string, value: unknown) {
    return this.file(name, JSON.stringify(value) + "\n")
  }
  async append(value: unknown) {
    await appendFile(join(this.output, "commands.jsonl"), JSON.stringify(value) + "\n", {mode: 0o600})
  }
  async capture(argv: string[]): Promise<ReturnCommandCapture> {
    const startedAt = new Date().toISOString()
    this.commands.push(argv)
    const stdout = await this.respond(argv)
    const finishedAt = new Date().toISOString()
    const evidence = await this.json(`command-${this.commands.length}.json`, {
      simulated: true,
      argv,
      startedAt,
      finishedAt,
      stdout,
      exitCode: 0,
    })
    return {startedAt, finishedAt, argv, exitCode: 0, stdout, evidence}
  }
  async run(argv: string[]) {
    return (await this.capture(argv)).stdout.trim()
  }
}
