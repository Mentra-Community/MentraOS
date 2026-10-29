#!/usr/bin/env node
import assert from "node:assert/strict"
import path from "node:path"
import {setTimeout as sleep} from "node:timers/promises"
import {pathToFileURL} from "node:url"

import {createRelease, githubApi} from "./github-release-create.mjs"

export {workflowCheckDenied} from "./github-release-create.mjs"

// The release for an installer version is immutable: reuse it when its
// coordinates match, otherwise create it through the shared retry, which also
// absorbs GitHub's workflow-file check timeouts for the new tag.
export async function ensureInstallerRelease({repository, tag, sourceCommit, api = githubApi, wait = sleep, log = console.error}) {
  if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(repository || "")) throw new Error("Invalid repository")
  const version = /^mentra-private-cloud-(\d+\.\d+\.\d+(?:-(?:dev|beta)\.[1-9]\d*)?)$/.exec(tag || "")?.[1]
  if (!version || !/^[a-f0-9]{40}$/.test(sourceCommit || "")) throw new Error("Invalid immutable installer coordinates")
  const validate = (release) => {
    assert.equal(release.tag_name, tag, "Installer release tag does not match")
    assert.equal(release.target_commitish, sourceCommit, "Installer release source does not match")
    assert.equal(release.draft, false, "Installer release must not be a draft")
    assert.equal(release.prerelease, true, "Installer release must remain a prerelease")
    assert.ok(Number.isSafeInteger(release.id) && release.id > 0, "Invalid installer release ID")
    return release
  }
  return createRelease({
    repository,
    release: {
      tag_name: tag,
      target_commitish: sourceCommit,
      name: `Mentra Private Cloud ${version}`,
      body: "Versioned Azure installer, checksum and publication evidence. Obtain the private IT guide and approved image access from Mentra before deployment.",
      draft: false,
      prerelease: true,
      make_latest: "false",
    },
    lookupFirst: true,
    validate,
    api,
    wait,
    log,
  })
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
