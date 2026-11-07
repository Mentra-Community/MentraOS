#!/usr/bin/env node
import {createHash} from "node:crypto"
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const BASE_URL = "https://central.sonatype.com"
const RESUMABLE_STATES = new Set(["PENDING", "VALIDATING", "PUBLISHING", "VALIDATED", "PUBLISHED"])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function responseJson(response, label) {
  const body = await response.text()
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}: ${body}`)
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`)
  }
}

function requireDeploymentRecord(record) {
  if (
    record?.schemaVersion !== 1 ||
    !UUID_PATTERN.test(record.deploymentId) ||
    !record.deploymentName ||
    !/^[0-9a-f]{64}$/.test(record.bundleSha256) ||
    !Array.isArray(record.expectedPurls) ||
    record.expectedPurls.length === 0
  ) {
    throw new Error("Invalid persisted Sonatype deployment record")
  }
  return record
}

// Every channel submits an AUTOMATIC deployment: Maven Central publishes it as
// soon as Sonatype validates it.
export async function uploadDeployment({bundle, token, deploymentName, expectedPurls, fetchImpl = fetch}) {
  if (!bundle || !token || !deploymentName || expectedPurls.length === 0) {
    throw new Error("Bundle, token, deployment name, and expected PURLs are required")
  }
  const bytes = readFileSync(bundle)
  const url = new URL("/api/v1/publisher/upload", BASE_URL)
  url.searchParams.set("name", deploymentName)
  url.searchParams.set("publishingType", "AUTOMATIC")
  const form = new FormData()
  form.append("bundle", new Blob([bytes], {type: "application/octet-stream"}), path.basename(bundle))
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {Authorization: `Bearer ${token}`},
    body: form,
  })
  const deploymentId = (await response.text()).trim()
  if (!response.ok) {
    throw new Error(`Sonatype deployment upload failed with HTTP ${response.status}: ${deploymentId}`)
  }
  if (!UUID_PATTERN.test(deploymentId)) throw new Error(`Sonatype returned an invalid deployment ID: ${deploymentId}`)
  return {
    schemaVersion: 1,
    deploymentId,
    deploymentName,
    bundleSha256: createHash("sha256").update(bytes).digest("hex"),
    expectedPurls,
    publishingType: "AUTOMATIC",
  }
}

async function deploymentStatus({fetchImpl, headers, deploymentId}) {
  const url = new URL("/api/v1/publisher/status", BASE_URL)
  url.searchParams.set("id", deploymentId)
  const response = await fetchImpl(url, {method: "POST", headers})
  return responseJson(response, "Sonatype deployment status")
}

function requireMatchingStatus(record, status) {
  if (status.deploymentId && status.deploymentId !== record.deploymentId) {
    throw new Error("Sonatype status belongs to another deployment")
  }
  if (status.deploymentName && status.deploymentName !== record.deploymentName) {
    throw new Error("Sonatype deployment name differs from the persisted release record")
  }
  return status
}

export async function inspectDeployment({record, token, fetchImpl = fetch}) {
  requireDeploymentRecord(record)
  if (!token) throw new Error("Sonatype token is required")
  const status = requireMatchingStatus(
    record,
    await deploymentStatus({
      fetchImpl,
      headers: {Authorization: `Bearer ${token}`},
      deploymentId: record.deploymentId,
    }),
  )
  const purls = status.purls || []

  if (status.deploymentState === "FAILED") {
    return {...record, disposition: "replace", deploymentState: status.deploymentState, errors: status.errors || []}
  }
  if (!RESUMABLE_STATES.has(status.deploymentState)) {
    throw new Error(
      `Sonatype deployment ${record.deploymentName} has unknown state ${JSON.stringify(status.deploymentState)}`,
    )
  }
  return {...record, disposition: "resume", deploymentState: status.deploymentState, purls}
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    values[option.slice(2)] = value
  }
  return values
}

async function main() {
  const command = process.argv[2]
  const args = parseArgs(process.argv.slice(3))
  let result
  if (command === "upload") {
    result = await uploadDeployment({
      bundle: path.resolve(args.bundle),
      token: process.env.MAVEN_CENTRAL_TOKEN_BASE64,
      deploymentName: args.name,
      expectedPurls: args["expected-purls"].split(","),
    })
  } else if (command === "inspect") {
    result = await inspectDeployment({
      record: JSON.parse(readFileSync(path.resolve(args.record), "utf8")),
      token: process.env.MAVEN_CENTRAL_TOKEN_BASE64,
    })
  } else {
    throw new Error(`Unknown command ${JSON.stringify(command)}`)
  }
  writeFileSync(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
