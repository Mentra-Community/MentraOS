#!/usr/bin/env node
import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import path from "node:path"
import {setTimeout as sleep} from "node:timers/promises"
import {pathToFileURL} from "node:url"

import {githubError} from "./publish-immutable-release-asset.mjs"

function githubApi(route, {method = "GET", data} = {}) {
  try {
    const output = execFileSync(
      "gh",
      ["api", "--include", "--method", method, route, ...(data ? ["--input", "-"] : [])],
      {encoding: "utf8", input: data ? JSON.stringify(data) : undefined, timeout: 120_000, stdio: ["pipe", "pipe", "pipe"]},
    )
    return JSON.parse(output.replace(/^HTTP\/\S+ \d{3}[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n/gm, ""))
  } catch (error) {
    throw githubError(error, String(error.stdout || ""), String(error.stderr || ""))
  }
}

const ATTEMPTS = 6

// Creating the tag makes GitHub decide whether the new ref creates or changes
// workflow files. That check can time out on this repository; GitHub then
// answers 403 as if the token lacked `workflows`, which GITHUB_TOKEN never
// holds. It names the alternative grant in X-Accepted-GitHub-Permissions.
export function workflowCheckDenied(error) {
  return error.status === 403 && !error.rateLimited && /(^|[;,\s])workflows=write\b/.test(error.acceptedPermissions || "")
}

function transient(error) {
  return (
    [408, 429, 500, 502, 503, 504].includes(error.status) ||
    (error.status === 403 && (error.rateLimited || error.retryAfterMs !== undefined)) ||
    workflowCheckDenied(error) ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENETUNREACH"].includes(error.code) ||
    error.cause?.signal === "SIGTERM"
  )
}

// Creation can commit before its response is lost. Look up the same immutable
// tag after every retry delay instead of blindly repeating the POST.
export async function ensureInstallerRelease({repository, tag, sourceCommit, api = githubApi, wait = sleep, log = console.error}) {
  if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(repository || "")) throw new Error("Invalid repository")
  const version = /^mentra-private-cloud-(\d+\.\d+\.\d+(?:-(?:dev|beta)\.[1-9]\d*)?)$/.exec(tag || "")?.[1]
  if (!version || !/^[a-f0-9]{40}$/.test(sourceCommit || "")) throw new Error("Invalid immutable installer coordinates")
  const route = `repos/${repository}/releases`
  const validate = (release) => {
    assert.equal(release.tag_name, tag, "Installer release tag does not match")
    assert.equal(release.target_commitish, sourceCommit, "Installer release source does not match")
    assert.equal(release.draft, false, "Installer release must not be a draft")
    assert.equal(release.prerelease, true, "Installer release must remain a prerelease")
    assert.ok(Number.isSafeInteger(release.id) && release.id > 0, "Invalid installer release ID")
    return release
  }
  const lookup = async () => {
    try {
      return validate(await api(`${route}/tags/${tag}`))
    } catch (error) {
      if (error.status === 404) return null
      throw error
    }
  }
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let error
    try {
      const existing = await lookup()
      if (existing) return existing
      try {
        return validate(await api(route, {
          method: "POST",
          data: {
            tag_name: tag,
            target_commitish: sourceCommit,
            name: `Mentra Private Cloud ${version}`,
            body: "Versioned Azure installer, checksum and publication evidence. Obtain the private IT guide and approved image access from Mentra before deployment.",
            draft: false,
            prerelease: true,
            make_latest: "false",
          },
        }))
      } catch (creationError) {
        // A concurrent publisher may have won the same tag. It must match all
        // coordinates; other validation errors are not retried.
        if (creationError.status === 422) {
          const existing = await lookup()
          if (existing) return existing
        }
        throw creationError
      }
    } catch (caught) {
      error = caught
    }
    if (!transient(error)) throw error
    const delay = Math.max(Math.min(5000 * 2 ** (attempt - 1), 60_000), error.retryAfterMs || 0)
    if (delay > 120_000) throw error
    const reason = workflowCheckDenied(error)
      ? "GitHub did not complete its workflow-file check for the new tag (HTTP 403)"
      : `Installer release lookup/create failed (${error.status ? `HTTP ${error.status}` : "transport error"})`
    log(`${reason}; reconciling the same tag after ${delay / 1000}s`)
    await wait(delay)
    if (attempt === ATTEMPTS) {
      const existing = await lookup()
      if (existing) return existing
      throw error
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const option = (name) => {
    const index = process.argv.indexOf(`--${name}`)
    if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`)
    return process.argv[index + 1]
  }
  try {
    const release = await ensureInstallerRelease({repository: option("repository"), tag: option("tag"), sourceCommit: option("source-commit")})
    console.log(release.id)
  } catch (error) {
    // SDK/CLI errors can carry request data. Keep workflow diagnostics bounded
    // to operation/status; the raw credential-bearing response is never logged.
    console.error(`Cannot resolve immutable installer release${error.status ? ` (HTTP ${error.status})` : ""}`)
    process.exitCode = 1
  }
}
