import {expect, test} from "bun:test"
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join, resolve} from "node:path"

test.skipIf(process.platform !== "darwin")(
  "native writer preserves generated frames and timestamps across source invalidation",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "mentra-recorder-writer-"))
    try {
      // Compile the production observer unchanged, without the UI driver entry point.
      const source = await readFile(resolve(import.meta.dir, "../native/Recorder.swift"), "utf8")
      const boundary = source.indexOf("\nfunc emitJSON(")
      expect(boundary).toBeGreaterThan(0)
      const observer = join(folder, "RecordingObserver.swift")
      await writeFile(observer, source.slice(0, boundary))
      const output = join(folder, "writer-tests")
      const build = Bun.spawnSync([
        "swiftc",
        "-swift-version",
        "6",
        "-parse-as-library",
        observer,
        resolve(import.meta.dir, "../native/tests/RecorderWriterTests.swift"),
        "-o",
        output,
      ])
      expect(build.stderr.toString()).toBe("")
      expect(build.exitCode).toBe(0)
      const run = Bun.spawn([output, folder], {stdout: "pipe", stderr: "pipe"})
      const timer = setTimeout(() => run.kill(), 15000)
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(run.stdout).text(),
          new Response(run.stderr).text(),
          run.exited,
        ])
        expect(code).toBe(0)
        // Apple's media frameworks may emit VM driver diagnostics even when
        // encoding/decoding succeeds. Preserve them; the native checks below
        // independently verify the actual frames, timestamps and duration.
        if (stderr.trim()) console.warn(stderr.trim())
        const result = JSON.parse(stdout)
        expect(result.times.slice(0, 2)).toEqual([0, 3])
        expect(result.times[2]).toBeGreaterThanOrEqual(8)
        expect(result.times[2]).toBeLessThan(10)
        expect(result).toMatchObject({
          status: "passed",
          scope: "generated frames only",
          frames: 3,
          duration: 10,
        })
      } finally {
        clearTimeout(timer)
      }
    } finally {
      await rm(folder, {recursive: true, force: true})
    }
  },
  30000,
)
