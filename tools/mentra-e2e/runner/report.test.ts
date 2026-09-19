import {expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {Report, type StepResult} from "./report"
import type {Doctor} from "./driver"
import type {Video} from "./video"

const passed: StepResult = {
  id: "OTA-01",
  instruction: "Observe update",
  expected: "Complete",
  status: "passed",
  durationMs: 0,
}
async function fixture(run: (report: Report) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "mentra-report-test-"))
  const executablePath = join(directory, "synthetic-app")
  await writeFile(executablePath, "test app")
  const report = new Report("ota", [], async () => ({executablePath} as Doctor))
  report.directory = directory
  report.metadata = {appExecutableHash: createHash("sha256").update("test app").digest("hex"), appJavascriptHash: null}
  report.video = {stop: async () => ({duration: 10, bytes: 100})} as Video
  try {
    await run(report)
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
}

test("screenshot failure cannot produce a passing Mac OTA report even if the caller requests passed", async () => {
  await fixture(async (report) => {
    report.video!.screenshot = async () => {
      throw new Error("injected screenshot failure")
    }
    expect((await report.record({...passed})).status).toBe("failed")
    expect(await report.finish("passed", "Update verified")).toBe("failed")
    expect(JSON.parse(await readFile(join(report.directory, "run.json"), "utf8")).status).toBe("failed")
    expect(await readFile(join(report.directory, "index.html"), "utf8")).toContain("injected screenshot failure")
  })
})

test("capture finalization and identity failures return incomplete; a valid run returns passed", async () => {
  for (const fault of ["video", "identity", "none"])
    await fixture(async (report) => {
      report.results.push({...passed})
      if (fault === "video")
        report.video!.stop = async () => {
          throw new Error("truncated")
        }
      if (fault === "identity") report.metadata.appExecutableHash = "different binary"
      const status = await report.finish("passed", "Done")
      expect(status).toBe(fault === "none" ? "passed" : "incomplete")
      expect(JSON.parse(await readFile(join(report.directory, "run.json"), "utf8")).status).toBe(status)
    })
})

test("failed steps stay failed when video finalization also fails; unexecuted steps cannot pass", async () => {
  for (const status of ["failed", "not-run"] as const)
    await fixture(async (report) => {
      report.results.push({...passed, status})
      report.video!.stop = async () => {
        throw new Error("truncated")
      }
      expect(await report.finish("passed", "Done")).toBe(status === "failed" ? "failed" : "incomplete")
    })
})
