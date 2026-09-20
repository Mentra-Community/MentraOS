import {createInterface} from "node:readline/promises"
import {appendFile} from "node:fs/promises"
import {join} from "node:path"
import {command, compact, snapshot, type Doctor} from "./driver"
import {acquireLock, Report} from "./report"
import {executeSteps, type Step} from "./suite"

export async function discover(fixture: string, buildManifestPath?: string) {
  const release = await acquireLock()
  const report = new Report("discovery", [])
  const input = createInterface({input: process.stdin, crlfDelay: Infinity})
  try {
    const doctor = await command<Doctor>({op: "doctor"})
    await report.start(doctor, fixture, buildManifestPath)
    report.metadata.executionMode = "interactive-discovery"
    report.metadata.modelCalls = null
    if (!doctor.accessibility || !doctor.screenCapture)
      throw new Error("Run doctor and complete macOS permissions first")
    await report.startVideo()
    console.log(JSON.stringify(compact(await snapshot())))
    console.log('Ready: one JSON Step per line; "stop" finalizes this discovery run.')
    for await (const line of input) {
      if (line.trim() === "stop") break
      try {
        const step = JSON.parse(line) as Step
        if (!step.id || !step.instruction || !step.expected || !Array.isArray(step.checks))
          throw new Error("A discovery step needs id, instruction, expected and checks")
        if (report.results.some((previous) => previous.id === step.id))
          throw new Error("Step IDs must be unique within the run")
        await appendFile(join(report.directory, "discovery-source.jsonl"), `${JSON.stringify(step)}\n`)
        await executeSteps([step], {fixture, email: "", password: ""}, report)
        console.log(JSON.stringify(compact(await snapshot())))
      } catch (error) {
        console.log(String(error))
      }
    }
    await report.finish(
      report.results.some((step) => step.status === "failed") ? "failed" : "observed",
      "Discovery session ended; consult final screenshot for app state",
    )
  } catch (error) {
    if (report.directory) await report.finish("incomplete", `Discovery setup/run failure: ${String(error)}`)
    throw error
  } finally {
    input.close()
    if (report.video) await report.finish("incomplete", "Discovery interrupted")
    await release()
  }
}
