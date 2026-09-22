#!/usr/bin/env bun
// Explicit local entry. Importing it never fetches or consumes a request.
import {parseArgs} from "node:util"
import {join} from "node:path"
import {inspectRoutineRequest} from "./ci-worker"
import {consumeRoutineRequest} from "./runner/ci-request"
import {createLocalRegistration} from "./runner/day1-local-runtime"
import {requireThat} from "./runner/day1-local-io"

export async function main(args: string[]) {
  const {positionals, values} = parseArgs({
    args,
    allowPositionals: true,
    options: {config: {type: "string"}, sha256: {type: "string"}},
  })
  requireThat(
    positionals.length === 1 &&
      ["describe", "check", "consume"].includes(positionals[0]) &&
      values.config &&
      values.sha256,
    "Usage: bun tools/mentra-e2e/day1-local.ts describe|check|consume --config /private/config.json --sha256 SHA256",
  )
  const local = await createLocalRegistration({path: values.config, sha256: values.sha256})
  if (positionals[0] === "describe") {
    console.log(
      JSON.stringify({
        status: "inputs-described",
        definitionDigest: local.definitionDigest,
        returnProfileDigest: local.returnProfileDigest,
        requestId: local.resolved.request.requestId,
        fullRoutinePassed: false,
        hardwareStarted: false,
        admissionVerified: false,
      }),
    )
    return
  }
  const checked = await local.check()
  if (positionals[0] === "check") {
    console.log(
      JSON.stringify({
        status: "prepared-for-authorized-lab-qualification",
        definitionDigest: local.definitionDigest,
        requestId: local.resolved.request.requestId,
        fixtureID: checked.fixtureID,
        fullRoutinePassed: false,
        hardwareStarted: false,
      }),
    )
    return
  }
  const {cfg, request} = local.resolved
  // Live authentication precedes the durable claim. The request never provides executable code.
  const actual = await inspectRoutineRequest(request.trigger.runId, request.trigger.runAttempt, cfg.trust.path)
  requireThat(actual.request.requestId === request.requestId, "The live request changed")
  const result = await consumeRoutineRequest(
    actual.request,
    actual.evidence,
    actual.trust,
    cfg.stateDirectory,
    local.registration,
  )
  console.log(JSON.stringify({status: result.status, requestId: request.requestId}))
  if (result.status === "routine-finished") {
    const exported = await local.exportCompleted(join(cfg.stateDirectory, "runs", request.requestId, "admin-export"))
    console.log(JSON.stringify({export: exported.outputDirectory, published: false}))
  }
}
if (import.meta.main)
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "Local routine failed")
    process.exitCode = 1
  })
