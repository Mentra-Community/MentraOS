#!/usr/bin/env node
// Creates GitHub releases and tag refs in this repository with GITHUB_TOKEN.
//
// Creating a release or a tag makes GitHub decide whether the new ref adds or
// changes workflow files. That check can time out on this repository; GitHub
// then answers 403 "Resource not accessible by integration" as if the token
// lacked `workflows`, which GITHUB_TOKEN never holds. It names that grant in
// X-Accepted-GitHub-Permissions. Every release and tag the workflows create goes
// through this module so that 403, rate limits and server errors are retried
// within one bounded budget, while every other 403 fails at once.
//
// Creation can commit before its response is lost, so each retry first looks
// for the same tag. A release or tag already there for the same commit is
// returned as the result; one at a different commit is an error.
//
// CLI (prints the release or ref JSON on stdout):
//   github-release-create.mjs release --repository OWNER/REPO --input payload.json|- [--shared-tag true]
//   github-release-create.mjs tag --repository OWNER/REPO --tag NAME --sha COMMIT
// Both commands reuse an existing match before creating anything.
import {execFileSync} from "node:child_process"
import {readFileSync} from "node:fs"
import path from "node:path"
import {setTimeout as sleep} from "node:timers/promises"
import {pathToFileURL} from "node:url"

import {githubError} from "./publish-immutable-release-asset.mjs"

export const CREATE_ATTEMPTS = 6
const MAX_DELAY_MS = 120_000
const REPOSITORY_PATTERN = /^[\w-][\w.-]*\/[\w-][\w.-]*$/
const TAG_PATTERN = /^[\w-][\w.-]*$/
const SHA_PATTERN = /^[a-f0-9]{40}$/
// Listing drafts inlines every asset of every release; keep only what callers read.
const RELEASE_LIST_FIELDS = "{id, tag_name, name, body, draft, prerelease, target_commitish, html_url, published_at}"

/** Runs one `gh api` request and returns parsed JSON with GitHub's status details on failure. */
export function githubApi(route, {method = "GET", data, paginate = false, jq} = {}) {
  const args = ["api", "--method", method, route]
  if (paginate) args.push("--paginate")
  if (jq) args.push("--jq", jq)
  else args.push("--include")
  if (data) args.push("--input", "-")
  try {
    const output = execFileSync("gh", args, {
      encoding: "utf8",
      input: data ? JSON.stringify(data) : undefined,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    })
    if (jq) {
      return output
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line))
    }
    return JSON.parse(output.replace(/^HTTP\/\S+ \d{3}[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n/gm, ""))
  } catch (error) {
    throw githubError(error, String(error.stdout || ""), String(error.stderr || ""))
  }
}

/** True for the 403 GitHub returns when its workflow-file check for a new ref timed out. */
export function workflowCheckDenied(error) {
  return error?.status === 403 && !error.rateLimited && /(^|[;,\s])workflows=write\b/.test(error.acceptedPermissions || "")
}

/** True for errors that may succeed on a later attempt: workflow-check 403s, rate limits, 5xx and transport failures. */
export function retryableCreateError(error) {
  return (
    [408, 429, 500, 502, 503, 504].includes(error?.status) ||
    (error?.status === 403 && (error.rateLimited || error.retryAfterMs !== undefined)) ||
    workflowCheckDenied(error) ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENETUNREACH"].includes(error?.code) ||
    error?.cause?.signal === "SIGTERM"
  )
}

/** Raised when the tag already exists for another commit or release; never retried. */
export class ReleaseConflictError extends Error {}

async function missingAsNull(request) {
  try {
    return await request()
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
}

async function tagCommit({repository, tag, api}) {
  const ref = await missingAsNull(() => api(`repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`))
  if (!ref) return null
  let object = ref.object
  // Annotated tags point at a tag object; follow it to the commit.
  for (let depth = 0; object?.type === "tag" && depth < 5; depth++) {
    object = (await api(`repos/${repository}/git/tags/${object.sha}`)).object
  }
  if (object?.type !== "commit" || !SHA_PATTERN.test(object.sha || "")) {
    throw new ReleaseConflictError(`Tag ${tag} does not identify a commit`)
  }
  return {ref, commit: object.sha}
}

// Retries `create` within the shared budget. Before every retry (and before the
// first attempt when `lookupFirst`), `find` decides whether an earlier attempt or
// a concurrent publisher already produced the result.
async function withCreateRetry({find, create, label, lookupFirst, wait, log}) {
  for (let attempt = 1; attempt <= CREATE_ATTEMPTS; attempt++) {
    let error
    try {
      if (lookupFirst || attempt > 1) {
        const existing = await find()
        if (existing) return existing
      }
      try {
        return await create()
      } catch (creationError) {
        // 422 means the tag or release already exists. Accept it only when it
        // matches; otherwise the validation error is permanent.
        if (creationError.status === 422) {
          const existing = await find()
          if (existing) return existing
        }
        throw creationError
      }
    } catch (caught) {
      error = caught
    }
    if (!retryableCreateError(error)) throw error
    const delay = Math.max(Math.min(5000 * 2 ** (attempt - 1), 60_000), error.retryAfterMs || 0)
    if (delay > MAX_DELAY_MS) throw error
    const reason = workflowCheckDenied(error)
      ? `GitHub did not complete its workflow-file check for ${label} (HTTP 403)`
      : `Creating ${label} failed (${error.status ? `HTTP ${error.status}` : "transport error"})`
    log(`${reason}; looking for the same tag after ${delay / 1000}s`)
    await wait(delay)
    if (attempt === CREATE_ATTEMPTS) {
      const existing = await find()
      if (existing) return existing
      throw error
    }
  }
}

/**
 * Creates a release from a GitHub release payload, or returns the release an
 * earlier attempt or a concurrent publisher created for the same tag.
 *
 * - `lookupFirst`: reuse an existing release before the first POST.
 * - `sharedTag`: the tag is shared across sources; reuse a release on it whatever its commit.
 * - `find`: override how an existing release is found (default: by tag, listing drafts).
 * - `validate`: checks every returned release; its errors are never retried.
 */
export async function createRelease({
  repository,
  release,
  lookupFirst = false,
  sharedTag = false,
  find,
  validate = (value) => value,
  api = githubApi,
  wait = sleep,
  log = console.error,
}) {
  if (!REPOSITORY_PATTERN.test(repository || "")) throw new Error("Invalid repository")
  const tag = release?.tag_name
  if (!TAG_PATTERN.test(tag || "") || tag.includes("..")) throw new Error("Invalid release tag")
  const target = release.target_commitish
  if (target !== undefined && (typeof target !== "string" || target === "")) throw new Error("Invalid release target")
  const route = `repos/${repository}/releases`
  const defaultFind = async () => {
    if (release.draft) {
      // Drafts have no tag yet and are invisible to the by-tag endpoint.
      const matches = await api(`${route}?per_page=100`, {
        paginate: true,
        jq: `.[] | select(.tag_name == ${JSON.stringify(tag)}) | ${RELEASE_LIST_FIELDS} | tojson`,
      })
      if (matches.length > 1) throw new ReleaseConflictError(`Multiple releases are tagged ${tag}`)
      return matches[0] || null
    }
    return missingAsNull(() => api(`${route}/tags/${encodeURIComponent(tag)}`))
  }
  // GitHub ignores target_commitish when the tag already exists, so the tag
  // itself is the authority on which commit a release identifies.
  const pinned = !sharedTag && SHA_PATTERN.test(target || "")
  const conflict = (actual) =>
    new ReleaseConflictError(`Tag ${tag} already identifies ${actual}, expected ${target}`)
  const matching = async (existing) => {
    if (existing.tag_name !== tag) throw new ReleaseConflictError(`Release lookup for ${tag} returned ${existing.tag_name}`)
    await validate(existing)
    if (!pinned) return existing
    const actual = await tagCommit({repository, tag, api})
    if (actual) {
      if (actual.commit !== target) throw conflict(actual.commit)
      return existing
    }
    // Only a draft may exist before its tag; it creates the tag at its target when published.
    if (existing.draft && existing.target_commitish === target) return existing
    throw new ReleaseConflictError(`Release ${tag} does not identify ${target}`)
  }
  // A tag that identifies another commit is refused before every attempt and
  // after a published release is created; an absent tag is created at target.
  const refuseMovedTag = async () => {
    const actual = pinned ? await tagCommit({repository, tag, api}) : null
    if (actual && actual.commit !== target) throw conflict(actual.commit)
  }
  return withCreateRetry({
    label: `release ${tag}`,
    lookupFirst,
    wait,
    log,
    find: async () => {
      const existing = await (find || defaultFind)()
      return existing ? matching(existing) : null
    },
    create: async () => {
      await refuseMovedTag()
      const created = await validate(await api(route, {method: "POST", data: release}))
      if (!created.draft) await refuseMovedTag()
      return created
    },
  })
}

/** Creates the lightweight tag `refs/tags/<tag>` at `sha`, or returns it if it already points there. */
export async function createTagRef({repository, tag, sha, lookupFirst = false, api = githubApi, wait = sleep, log = console.error}) {
  if (!REPOSITORY_PATTERN.test(repository || "")) throw new Error("Invalid repository")
  if (!TAG_PATTERN.test(tag || "") || tag.includes("..")) throw new Error("Invalid tag")
  if (!SHA_PATTERN.test(sha || "")) throw new Error("Tag target must be a full commit SHA")
  return withCreateRetry({
    label: `tag ${tag}`,
    lookupFirst,
    wait,
    log,
    find: async () => {
      const existing = await tagCommit({repository, tag, api})
      if (!existing) return null
      if (existing.commit !== sha) throw new ReleaseConflictError(`Tag ${tag} already points to ${existing.commit}, expected ${sha}`)
      return existing.ref
    },
    create: () => api(`repos/${repository}/git/refs`, {method: "POST", data: {ref: `refs/tags/${tag}`, sha}}),
  })
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...rest] = process.argv.slice(2)
  try {
    const args = parseArgs(rest)
    const required = (name) => {
      if (!args[name]) throw new Error(`Missing --${name}`)
      return args[name]
    }
    let result
    if (command === "release") {
      const input = required("input")
      const release = JSON.parse(readFileSync(input === "-" ? 0 : path.resolve(input), "utf8"))
      if (!["true", "false", undefined].includes(args["shared-tag"])) throw new Error("--shared-tag must be true or false")
      result = await createRelease({
        repository: required("repository"),
        release,
        lookupFirst: true,
        sharedTag: args["shared-tag"] === "true",
      })
    } else if (command === "tag") {
      result = await createTagRef({repository: required("repository"), tag: required("tag"), sha: required("sha"), lookupFirst: true})
    } else {
      throw new Error("Usage: github-release-create.mjs release|tag --repository OWNER/REPO ...")
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    // gh errors can carry request data. Report only status for API failures;
    // local validation and conflict messages are this module's own text.
    const local = !error.cause && error.status === undefined && error.code === undefined
    const detail = error.status
      ? `HTTP ${error.status}${workflowCheckDenied(error) ? ", workflow-file check incomplete" : ""}`
      : local
        ? error.message
        : "transport error"
    console.error(`Cannot create the GitHub ${command === "tag" ? "tag" : "release"} (${detail})`)
    process.exitCode = 1
  }
}
