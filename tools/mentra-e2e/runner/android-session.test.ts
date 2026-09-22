import {expect, test} from "bun:test"
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {androidNodes, AndroidSession} from "./android-session"

test("Android semantic dump retains IDs and decodes UI text", () => {
  expect(
    androidNodes(
      '<hierarchy><node text="Update &amp; restart" content-desc="" resource-id="button-Update Now" /></hierarchy>',
    ),
  ).toEqual([{text: "Update & restart", description: "", id: "button-Update Now"}])
})
test("An incomplete UI dump cannot be treated as an empty successful screen", () => {
  expect(() => androidNodes('<hierarchy><node text="Update Complete"/>')).toThrow("Incomplete")
})
test("Recorder requires an explicit safe device and physical display", () => {
  expect(() => new AndroidSession("device;anything", "123", "test", "/tmp/test")).toThrow()
  expect(() => new AndroidSession("ZY22JWCN97", "default", "test", "/tmp/test")).toThrow()
})

test("A duplicate run directory preserves the original evidence during cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mentra-android-existing-"))
  try {
    await writeFile(join(directory, "result.json"), "original evidence")
    const session = new AndroidSession("example-phone", "123", "test", directory)
    await expect(session.start()).rejects.toThrow()
    await session.finish("failed")
    expect(await readFile(join(directory, "result.json"), "utf8")).toBe("original evidence")
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})

async function recordingFixture(
  run: (
    session: AndroidSession,
    exit: (code: number) => void,
    controls: {duration: number; stopCode: number; probeFails: boolean},
  ) => Promise<void>,
) {
  const parent = await mkdtemp(join(tmpdir(), "mentra-android-recorder-"))
  const directory = join(parent, "run")
  const controls = {duration: 30, stopCode: 0, probeFails: false}
  let resolveExit!: (code: number) => void
  const child = {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null,
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve
    }),
    kill: () => exit(controls.stopCode),
    terminal: {close: () => {}},
  }
  const exit = (code: number) => {
    child.exitCode = code
    resolveExit(code)
  }
  const runtime = {
    command: async (args: string[]) => {
      if (args[0] === "ffprobe") {
        if (controls.probeFails) throw new Error("Video unreadable")
        return Buffer.from(JSON.stringify({format: {duration: controls.duration}, streams: [{codec_type: "video"}]}))
      }
      if (args.includes("get-state")) return Buffer.from("device")
      if (args.includes("cat")) return Buffer.from('<hierarchy><node text="Call"/></hierarchy>')
      if (args.includes("screencap")) {
        const png = Buffer.alloc(24)
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
        png.writeUInt32BE(100, 16)
        png.writeUInt32BE(200, 20)
        return png
      }
      if (args.includes("dump") || args.includes("rm")) return Buffer.alloc(0)
      throw new Error(`Unexpected command in offline test: ${args}`)
    },
    startRecorder: (_args: string[], onData: (chunk: Uint8Array) => void) => {
      void writeFile(join(directory, "routine.mp4"), "synthetic video").then(() =>
        onData(Buffer.from("Recording started")),
      )
      return child
    },
  }
  // Substitute only the process/ADB boundary; execute real start, step, finish and evidence writers.
  const session = new AndroidSession("fixture", "0", "test", directory, "deterministic-replay", runtime as any)
  try {
    await session.start()
    await run(session, exit, controls)
  } finally {
    if (child.exitCode === null) exit(0)
    await rm(parent, {recursive: true, force: true})
  }
}

test("recorder loss during the last action fails the step and final report while retaining evidence", async () => {
  await recordingFixture(async (session, exit) => {
    await expect(
      session.step("last", "Final action", "Captured", async () => {
        exit(1)
      }),
    ).rejects.toThrow("Recorder")
    await expect(session.finish("passed")).rejects.toThrow("Recorder")
    const result = JSON.parse(await readFile(join(session.directory, "result.json"), "utf8"))
    expect(result.status).toBe("failed")
    expect(result.steps[0].status).toBe("failed")
    expect(result.steps[0].screenshot).toBeDefined()
    expect(await readFile(join(session.directory, "index.html"), "utf8")).toContain("failed")
  })
})

test("any exit before requested stop fails even after the last step, including exit zero", async () => {
  for (const code of [0, 1])
    await recordingFixture(async (session, exit) => {
      await session.step("last", "Final action", "Captured", async () => {})
      exit(code)
      await expect(session.finish("passed")).rejects.toThrow("Recorder")
      expect(JSON.parse(await readFile(join(session.directory, "result.json"), "utf8")).status).toBe("failed")
    })
})

test("short recordings cannot hide late chapters, even when recorder stop succeeds", async () => {
  await recordingFixture(async (session, _exit, controls) => {
    await session.step("last", "Final action", "Captured", async () => {})
    const origin = JSON.parse(await readFile(join(session.directory, "result.json"), "utf8")).recordingOriginMs
    session.steps[0].startedAt = new Date(origin + 10000).toISOString()
    session.steps[0].finishedAt = new Date(origin + 11000).toISOString()
    controls.duration = 1
    await expect(session.finish("passed")).rejects.toThrow("before the routine ends")
    const chapters = JSON.parse(await readFile(join(session.directory, "chapters.json"), "utf8"))
    expect(chapters[0].videoSeconds).toBeCloseTo(9.5, 2)
    expect(JSON.parse(await readFile(join(session.directory, "result.json"), "utf8")).status).toBe("failed")
  })
})

test("finalization errors produce failed evidence and throw; a complete recording passes", async () => {
  for (const fault of ["exit", "probe", "empty", "none"])
    await recordingFixture(async (session, _exit, controls) => {
      await session.step("last", "Final action", "Captured", async () => {})
      controls.stopCode = fault === "exit" ? 1 : 0
      controls.probeFails = fault === "probe"
      controls.duration = fault === "empty" ? 0 : 30
      if (fault === "none") expect(await session.finish("passed")).toBe("passed")
      else await expect(session.finish("passed")).rejects.toThrow()
      expect(JSON.parse(await readFile(join(session.directory, "result.json"), "utf8")).status).toBe(
        fault === "none" ? "passed" : "failed",
      )
    })
})
