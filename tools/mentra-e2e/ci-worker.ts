#!/usr/bin/env bun
import {execFileSync} from "node:child_process"
import {constants} from "node:fs"
import {open} from "node:fs/promises"
import {parseArgs} from "node:util"
import {
  assertRequestTrust,
  consumeRoutineRequest,
  parseRequestTrust,
  parseRoutineRequest,
  REQUEST_REPOSITORY,
  REQUEST_WORKFLOW,
  sha256,
  type RequestEvidence,
} from "./runner/ci-request"

const HELP = `Authenticated CI request intake. This does not install an app or run hardware.

bun ci-worker.ts list
bun ci-worker.ts inspect --run ID --attempt N --trust PRIVATE.json
bun ci-worker.ts consume --run ID --attempt N --trust PRIVATE.json --state PRIVATE_DIRECTORY

Use a reviewed local checkout. The trust file explicitly pins each allowed PR,
head/base SHA, workflow SHA and merge checkout SHA; a PR label is insufficient.
Inspect verifies the GitHub run and request ZIP. Consume writes an exclusive
durable claim and a no-artifact or blocked-unqualified result. It cannot pass a
device test. Existing claims are never dispatched again, including after crashes.

Trust JSON: {"schemaVersion":1,"repository":"Mentra-Community/MentraOS","entries":[
  {"kind":"pull_request","pr":4136,"headSha":"40_HEX","baseSha":"40_HEX",
   "sourceSha":"40_HEX_MERGE_COMMIT","workflowSha":"40_HEX_MERGE_COMMIT"}]}

Requires authenticated gh, Python 3 and Bun. Keep trust/state outside Git.
Exit status: 0 inspected ready; 2 no artifact; 3 unqualified; 4 already claimed;
1 invalid, untrusted, unavailable or interrupted intake. No automatic lease expiry.
`
const MAX_ARCHIVE = 4 * 1024 * 1024
const repositoryPath = `repos/${REQUEST_REPOSITORY}`
function gh(path: string, binary = false) {
  return execFileSync("gh", ["api", "--hostname", "github.com", path], {
    maxBuffer: binary ? MAX_ARCHIVE : 8 * 1024 * 1024,
    timeout: 30_000,
    encoding: binary ? undefined : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}
function api(path: string): any {
  return JSON.parse(String(gh(`${repositoryPath}/${path}`)))
}
function positive(value: string | undefined, name: string) {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`Expected positive ${name}`)
  return Number(value)
}
async function trustFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 1024 * 1024 || stat.mode & 0o022)
      throw new Error("Trust policy must be a regular file under 1 MiB, not writable by other users")
    const bytes = Buffer.alloc(1024 * 1024 + 1)
    const {bytesRead} = await file.read(bytes)
    return parseRequestTrust(bytes.subarray(0, bytesRead))
  } finally {
    await file.close()
  }
}

export function extractRequest(archive: Uint8Array): Uint8Array {
  if (archive.length > MAX_ARCHIVE) throw new Error("Request archive exceeds 4 MiB")
  return execFileSync(
    "python3",
    [
      "-c",
      `import io,stat,sys,zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
    entries=z.infolist()
    if len(entries)!=1 or entries[0].filename!="request.json":
        raise ValueError("Request archive must contain only request.json")
    entry=entries[0]
    if entry.file_size>1048576 or entry.flag_bits&1 or stat.S_ISLNK(entry.external_attr>>16):
        raise ValueError("Invalid request archive entry")
    sys.stdout.buffer.write(z.read(entry))
`,
    ],
    {input: archive, timeout: 10_000, maxBuffer: 1024 * 1024 + 1, stdio: ["pipe", "pipe", "pipe"]},
  )
}

async function inspect(runId: number, attempt: number, trustPath: string) {
  const trust = await trustFile(trustPath)
  const run = api(`actions/runs/${runId}/attempts/${attempt}`)
  if (
    run.id !== runId ||
    run.run_attempt !== attempt ||
    run.path !== REQUEST_WORKFLOW ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    throw new Error("Request workflow attempt has not completed successfully")
  const name = `mentra-routine-request-${runId}-${attempt}`
  const matches: any[] = []
  for (let page = 1; page <= 10; page++) {
    const response = api(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`)
    if (!Array.isArray(response.artifacts)) throw new Error("GitHub did not return workflow artifacts")
    matches.push(...response.artifacts.filter((artifact: any) => artifact.name === name))
    if (page * 100 >= response.total_count) break
    if (page === 10) throw new Error("Request run has too many artifacts")
  }
  if (matches.length !== 1) throw new Error("Expected exactly one immutable artifact for this request attempt")
  const artifact = matches[0]
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    artifact.expired ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    artifact.size_in_bytes > MAX_ARCHIVE
  )
    throw new Error("Request artifact is invalid, expired or too large")
  const archive = gh(`${repositoryPath}/actions/artifacts/${artifact.id}/zip`, true) as Buffer
  const archiveSha256 = sha256(archive)
  if (artifact.digest !== `sha256:${archiveSha256}`)
    throw new Error("Downloaded request ZIP differs from the authenticated Actions artifact digest")
  const requestBytes = extractRequest(archive)
  const request = parseRoutineRequest(requestBytes)
  const currentPr = api(`pulls/${request.pullRequest.number}`)
  const sourceCommit = api(`commits/${request.trigger.sha}`)
  const evidence: RequestEvidence = {run, artifact, archiveSha256, sourceCommit, currentPr}
  assertRequestTrust(request, trust, evidence)
  return {request, trust, evidence, requestSha256: sha256(requestBytes)}
}

async function main() {
  const {values, positionals} = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: {type: "boolean"},
      run: {type: "string"},
      attempt: {type: "string"},
      trust: {type: "string"},
      state: {type: "string"},
    },
  })
  if (values.help || !positionals.length) {
    console.log(HELP)
    return
  }
  if (positionals.length !== 1 || !["list", "inspect", "consume"].includes(positionals[0])) throw new Error(HELP)
  if (positionals[0] === "list") {
    if (Object.keys(values).length) throw new Error("list takes no options")
    const response = api(`actions/workflows/request-e2e-routine.yml/runs?per_page=30`)
    console.log(
      JSON.stringify(
        response.workflow_runs.map((run: any) => ({
          runId: run.id,
          attempt: run.run_attempt,
          event: run.event,
          headSha: run.head_sha,
          status: run.status,
          conclusion: run.conclusion,
          url: run.html_url,
        })),
        null,
        2,
      ),
    )
    return
  }
  if (!values.trust) throw new Error("--trust is required")
  if (positionals[0] === "consume" && !values.state) throw new Error("consume requires --state")
  if (positionals[0] === "inspect" && values.state) throw new Error("inspect does not write state; omit --state")
  const verified = await inspect(positive(values.run, "run ID"), positive(values.attempt, "attempt"), values.trust)
  if (positionals[0] === "inspect") {
    console.log(
      JSON.stringify(
        {
          request: verified.request,
          requestSha256: verified.requestSha256,
          artifactId: verified.evidence.artifact.id,
          artifactSha256: verified.evidence.archiveSha256,
          authenticated: true,
          hardwareStarted: false,
        },
        null,
        2,
      ),
    )
    process.exitCode = verified.request.status === "no-artifact" ? 2 : 0
    return
  }
  const result = await consumeRoutineRequest(verified.request, verified.evidence, verified.trust, values.state!)
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.status === "no-artifact" ? 2 : result.status === "blocked-unqualified" ? 3 : 4
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
