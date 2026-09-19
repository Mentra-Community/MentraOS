import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {readFile, stat, writeFile} from "node:fs/promises"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {artifactUrl} from "./release-artifact-storage.mjs"

export function iosReceiptName(pr, sha, runId, attempt) {
  if (
    !Number.isSafeInteger(pr) ||
    pr <= 0 ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !Number.isSafeInteger(attempt) ||
    attempt <= 0
  )
    throw new Error("Invalid iOS publication coordinates")
  return `mentra-ios-pr-${pr}-${sha}-${runId}-${attempt}.json`
}

export function validateIosReceipt(receipt, {pr, sha, runId, attempt}) {
  iosReceiptName(pr, sha, runId, attempt)
  if (
    receipt.schemaVersion !== 1 ||
    receipt.pr !== pr ||
    receipt.headSha !== sha ||
    receipt.runId !== runId ||
    receipt.runAttempt !== attempt ||
    !/^[a-f0-9]{40}$/.test(receipt.buildSha) ||
    (receipt.buildAttempt ?? receipt.runAttempt) > attempt
  )
    throw new Error("iOS receipt belongs to a different revision or workflow attempt")
  const sourceName = iosReceiptName(pr, sha, runId, receipt.buildAttempt ?? receipt.runAttempt)
  const suffix = sourceName.slice("mentra-ios-".length, -".json".length)
  if (Object.keys(receipt.artifacts || {}).sort().join(",") !== "iphone,mac")
    throw new Error("Invalid iOS artifact set")
  for (const [kind, ext] of [
    ["iphone", "ipa"],
    ["mac", "zip"],
  ]) {
    const asset = receipt.artifacts?.[kind]
    if (
      asset?.name !== `mentra-ios-${kind}-${suffix}.${ext}` ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0
    )
      throw new Error(`Invalid iOS ${kind} artifact`)
  }
  return receipt.artifacts
}

export async function publishIosArtifacts(directory, env = process.env) {
  const coordinates = {
    pr: Number(env.PR_NUMBER),
    sha: env.PR_HEAD_SHA,
    runId: Number(env.SOURCE_RUN_ID),
    attempt: Number(env.SOURCE_RUN_ATTEMPT),
  }
  let receiptName = iosReceiptName(coordinates.pr, coordinates.sha, coordinates.runId, coordinates.attempt)
  const receipt = JSON.parse(await readFile(path.join(directory, receiptName), "utf8"))
  const assets = validateIosReceipt(receipt, coordinates)
  const repository = env.GITHUB_REPOSITORY
  const releaseId = execFileSync("gh", ["api", `repos/${repository}/releases/tags/pr-builds`, "--jq", ".id"], {
    encoding: "utf8",
  }).trim()
  for (const asset of Object.values(assets)) {
    const file = path.join(directory, asset.name)
    if (
      (await stat(file)).size !== asset.size ||
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex") !== asset.sha256
    )
      throw new Error(`Handoff bytes do not match receipt: ${asset.name}`)
  }
  // A failed-jobs rerun republishes the original build bytes, but gets a new
  // receipt for this publication attempt so the notifier cannot pick an old run.
  receipt.buildAttempt = coordinates.attempt
  receipt.runAttempt = Number(env.GITHUB_RUN_ATTEMPT)
  receiptName = iosReceiptName(coordinates.pr, coordinates.sha, coordinates.runId, receipt.runAttempt)
  validateIosReceipt(receipt, {...coordinates, attempt: receipt.runAttempt})
  await writeFile(path.join(directory, receiptName), JSON.stringify(receipt, null, 2) + "\n")
  // The existing publisher verifies uploaded bytes and recovers ambiguous uploads.
  // Commit the receipt last: it signifies that both immutable assets were verified.
  for (const name of [...Object.values(assets).map((asset) => asset.name), receiptName]) {
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("./publish-immutable-release-asset.mjs", import.meta.url)),
        "--file",
        path.join(directory, name),
        "--name",
        name,
        "--release-id",
        releaseId,
        "--repository",
        repository,
      ],
      {stdio: "inherit", env},
    )
    console.log(artifactUrl(repository, "pr-builds", name))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await publishIosArtifacts(path.resolve(process.argv[2] || "pr-ios-output"))
