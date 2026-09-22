#!/usr/bin/env bun
import {parseArgs} from "node:util"
import {exportDay1Run} from "./runner/day1-run-exporter"
const HELP = `Export a finalized supervised day-one customer recording for the existing admin publisher.

bun export-day1-run.ts --run-directory FINAL_RUN --assessment REVIEWED_JSON --output NEW_DIRECTORY

No network or device calls. The source must have ended and its recording must be finalized.
Assessment schema is Day1Assessment in runner/day1-run-exporter.ts. Bind it to the final
source run SHA-256, exact CI receipt/manifest hashes, explicit test/teardown/fixture verdicts,
and optional related CI request (context only; never consumed by this manual run).
Passing test or ready fixture requires the complete firmware-state verifier and its bound
profile/fixture/observation files. All final verification must occur within the recorded run.
The assessment is a reviewed claim; this exporter does not authenticate hardware evidence.

Requires ffprobe and ffmpeg (complete screenshot decoding). Each video/screenshot must fit
the existing 128 MiB admin limit. Install Cloud V2 dependencies for the canonical schema.
Paths must not traverse symlinks. Source files remain unchanged. The output directory must not exist;
partial output after a failure has no publishable run.json. No raw logs, AX trees, credentials,
HTML or firmware files are exported. Use publish-test-run.ts separately after reviewing output.
`
async function main() {
  const {values} = parseArgs({
    options: {
      "help": {type: "boolean"},
      "run-directory": {type: "string"},
      "assessment": {type: "string"},
      "output": {type: "string"},
    },
  })
  if (values.help) {
    console.log(HELP)
    return
  }
  if (!values["run-directory"] || !values.assessment || !values.output) throw new Error(HELP)
  const {result: _, ...summary} = await exportDay1Run({
    runDirectory: values["run-directory"],
    assessmentPath: values.assessment,
    outputDirectory: values.output,
  })
  console.log(JSON.stringify(summary, null, 2))
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Export failed")
    process.exitCode = 1
  })
