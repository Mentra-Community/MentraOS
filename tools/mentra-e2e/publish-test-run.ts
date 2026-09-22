#!/usr/bin/env bun
import {parseArgs} from "node:util"
import {publishTestRun} from "./runner/test-run-publisher"

const HELP = `Publish an immutable routine result and explicitly selected evidence. No device operations.

bun publish-test-run.ts --run FILE --assets FILE --evidence-root DIRECTORY --journal FILE

Required environment: MENTRA_E2E_CORE_URL, MENTRA_E2E_ADMIN_URL, TEST_RUN_INGEST_TOKEN.
URLs must be HTTPS origins; HTTP is accepted only for loopback testing. No token CLI flag.
Local asset map: {"schemaVersion":1,"assets":[{"assetId":"recording","path":"video.mp4"}]}.
Paths are relative to the evidence root, with no symlinks or traversal. Empty assets are allowed.
The backend validates the full contract in core/src/types/test-run.types.ts. Local preflight
checks transport fields only. This uploader does not attest to device behavior.
All assets must match their declared size and SHA-256 before any network request (128 MiB each;
metadata 1 MiB). HTML is not a supported asset type. No directories are uploaded implicitly.
The journal parent must exist. Keep the append-only journal outside Git and reuse it to retry.
Retries ask the server which assets are missing; they never rerun a routine or change its verdict.
`

async function main() {
  const {values} = parseArgs({
    options: {
      "help": {type: "boolean"},
      "run": {type: "string"},
      "assets": {type: "string"},
      "evidence-root": {type: "string"},
      "journal": {type: "string"},
    },
    allowPositionals: false,
  })
  if (values.help) {
    console.log(HELP)
    return
  }
  if (!values.run || !values.assets || !values["evidence-root"] || !values.journal) throw new Error(HELP)
  const result = await publishTestRun({
    metadataPath: values.run,
    assetsPath: values.assets,
    evidenceRoot: values["evidence-root"],
    journalPath: values.journal,
    coreUrl: process.env.MENTRA_E2E_CORE_URL ?? "",
    adminUrl: process.env.MENTRA_E2E_ADMIN_URL ?? "",
    token: process.env.TEST_RUN_INGEST_TOKEN ?? "",
  })
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.main)
  main().catch((error) => {
    // Even malformed CLI arguments and filesystem errors must not echo the configured token.
    const token = process.env.TEST_RUN_INGEST_TOKEN
    const message = error instanceof Error ? error.message : "Evidence publication failed"
    console.error(token ? message.replaceAll(token, "[redacted]") : message)
    process.exitCode = 1
  })
