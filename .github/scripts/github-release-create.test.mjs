import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {readdirSync, readFileSync} from "node:fs"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {
  CREATE_ATTEMPTS,
  ReleaseConflictError,
  createRelease,
  createTagRef,
  retryableCreateError,
  workflowCheckDenied,
} from "./github-release-create.mjs"

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptsDir, "../..")
const sha = "a".repeat(40)
const other = "b".repeat(40)
const payload = {tag_name: "mentra-v3.3.0-dev.7", target_commitish: sha, name: "Mentra 3.3.0-dev.7", draft: false, prerelease: true}
const release = {id: 42, ...payload}
const failure = (status, properties = {}) => Object.assign(new Error("API failed"), {status, ...properties})
const missing = () => failure(404)
const workflowCheck = () => failure(403, {acceptedPermissions: "contents=write; contents=write,workflows=write"})
const budget = [5000, 10000, 20000, 40000, 60000, 60000]

function fixture(responses) {
  const calls = [], delays = [], logs = []
  return {
    args: {
      repository: "owner/repo",
      api: async (route, options = {}) => {
        calls.push({route, ...options})
        const response = responses.shift()
        assert.notEqual(response, undefined, `unexpected API request ${route}`)
        if (response instanceof Error) throw response
        return response
      },
      wait: async (delay) => delays.push(delay),
      log: (message) => logs.push(message),
    },
    calls, delays, logs,
    posts: () => calls.filter((call) => call.method === "POST"),
  }
}

test("creates a release with the exact payload in one request", async () => {
  const f = fixture([release])
  assert.deepEqual(await createRelease({...f.args, release: payload}), release)
  assert.deepEqual(f.calls, [{route: "repos/owner/repo/releases", method: "POST", data: payload}])
})

test("retries the workflow-check 403, looking for the tag before each retry, then succeeds", async () => {
  const f = fixture([workflowCheck(), missing(), workflowCheck(), missing(), release])
  assert.deepEqual(await createRelease({...f.args, release: payload}), release)
  assert.deepEqual(f.delays, [5000, 10000])
  assert.equal(f.posts().length, 3)
  assert.equal(f.calls[1].route, `repos/owner/repo/releases/tags/${payload.tag_name}`)
  assert.match(f.logs[0], /workflow-file check for release mentra-v3\.3\.0-dev\.7 \(HTTP 403\)/)
})

test("fails at once on any other 403", async () => {
  for (const denial of [failure(403), failure(403, {acceptedPermissions: "contents=write"})]) {
    const f = fixture([denial])
    await assert.rejects(createRelease({...f.args, release: payload}), (error) => error === denial)
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.delays, [])
  }
})

test("retries rate limits and server errors but not client errors", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(retryableCreateError(failure(status)), true)
  assert.equal(retryableCreateError(failure(403, {rateLimited: true, retryAfterMs: 60000})), true)
  assert.equal(retryableCreateError(failure(undefined, {code: "ECONNRESET"})), true)
  for (const status of [400, 401, 403, 404, 422]) assert.equal(retryableCreateError(failure(status)), false)
  assert.equal(workflowCheckDenied(failure(403, {rateLimited: true, acceptedPermissions: "workflows=write"})), false)
})

test("returns the release a lost-response attempt committed at the same commit", async () => {
  const f = fixture([failure(502), release])
  assert.deepEqual(await createRelease({...f.args, release: payload}), release)
  assert.equal(f.posts().length, 1)
})

test("accepts a published release created at another commitish when its tag is the same commit", async () => {
  const existing = {...release, target_commitish: "staging"}
  const f = fixture([workflowCheck(), existing, {object: {type: "commit", sha}}])
  assert.deepEqual(await createRelease({...f.args, release: payload}), existing)
  assert.equal(f.calls[2].route, `repos/owner/repo/git/ref/tags/${payload.tag_name}`)
})

test("follows an annotated tag to its commit", async () => {
  const existing = {...release, target_commitish: "main"}
  const f = fixture([failure(422), existing, {object: {type: "tag", sha: "c".repeat(40)}}, {object: {type: "commit", sha}}])
  assert.deepEqual(await createRelease({...f.args, release: payload}), existing)
})

test("rejects an existing release whose tag is at a different commit, without retrying", async () => {
  const existing = {...release, target_commitish: other}
  const f = fixture([failure(422), existing, {object: {type: "commit", sha: other}}])
  await assert.rejects(createRelease({...f.args, release: payload}), ReleaseConflictError)
  assert.deepEqual(f.delays, [])
})

test("a shared tag reuses its release whatever commit created it", async () => {
  const existing = {...release, target_commitish: other}
  const f = fixture([existing])
  assert.deepEqual(await createRelease({...f.args, release: payload, lookupFirst: true, sharedTag: true}), existing)
  assert.equal(f.posts().length, 0)
})

test("lookupFirst reuses an existing release and never treats a failed lookup as absence", async () => {
  const f = fixture([failure(503), release])
  assert.deepEqual(await createRelease({...f.args, release: payload, lookupFirst: true}), release)
  assert.equal(f.posts().length, 0)
  assert.deepEqual(f.delays, [5000])
})

test("a 422 without a matching release stays a permanent failure", async () => {
  const f = fixture([failure(422), missing()])
  await assert.rejects(createRelease({...f.args, release: payload}), (error) => error.status === 422)
  assert.deepEqual(f.delays, [])
})

test("gives up after the bounded budget and preserves the workflow-check failure", async () => {
  const responses = [workflowCheck()]
  for (let attempt = 2; attempt <= CREATE_ATTEMPTS; attempt++) responses.push(missing(), workflowCheck())
  const f = fixture([...responses, missing()])
  await assert.rejects(createRelease({...f.args, release: payload}), (error) => workflowCheckDenied(error))
  assert.deepEqual(f.delays, budget)
  assert.equal(f.posts().length, CREATE_ATTEMPTS)
})

test("honors a cooldown but refuses one beyond the budget", async () => {
  const cooled = fixture([failure(429, {retryAfterMs: 12000}), release])
  await createRelease({...cooled.args, release: payload})
  assert.deepEqual(cooled.delays, [12000])
  const over = fixture([failure(429, {retryAfterMs: 300000})])
  await assert.rejects(createRelease({...over.args, release: payload}), (error) => error.status === 429)
  assert.deepEqual(over.delays, [])
})

test("finds drafts by listing, since they have no tag yet", async () => {
  const draftPayload = {...payload, draft: true, prerelease: false}
  const draft = {id: 9, ...draftPayload}
  const f = fixture([workflowCheck(), [draft]])
  assert.deepEqual(await createRelease({...f.args, release: draftPayload}), draft)
  assert.equal(f.calls[1].route, "repos/owner/repo/releases?per_page=100")
  assert.equal(f.calls[1].paginate, true)
  assert.match(f.calls[1].jq, /select\(\.tag_name == "mentra-v3\.3\.0-dev\.7"\)/)
  const duplicate = fixture([failure(500), [draft, {...draft, id: 10}]])
  await assert.rejects(createRelease({...duplicate.args, release: draftPayload}), /Multiple releases/)
  const moved = fixture([failure(500), [{...draft, target_commitish: other}]])
  await assert.rejects(createRelease({...moved.args, release: draftPayload}), ReleaseConflictError)
})

test("caller validation applies to created and found releases and is never retried", async () => {
  const validate = (value) => {
    if (value.name !== payload.name) throw new Error("unexpected name")
    return value
  }
  const f = fixture([{...release, name: "other"}])
  await assert.rejects(createRelease({...f.args, release: payload, validate}), /unexpected name/)
  const found = fixture([failure(500), {...release, name: "other"}])
  await assert.rejects(createRelease({...found.args, release: payload, validate}), /unexpected name/)
  assert.equal(found.posts().length, 1)
})

test("invalid inputs never reach GitHub", async () => {
  const f = fixture([])
  await assert.rejects(createRelease({...f.args, repository: "../repo", release: payload}))
  await assert.rejects(createRelease({...f.args, release: {...payload, tag_name: "a/../b"}}))
  await assert.rejects(createTagRef({...f.args, tag: "mentra-v1", sha: "main"}))
  assert.deepEqual(f.calls, [])
})

test("creates a tag ref, retrying the workflow-check 403", async () => {
  const ref = {ref: "refs/tags/mentra-v1", object: {type: "commit", sha}}
  const f = fixture([workflowCheck(), missing(), ref])
  assert.deepEqual(await createTagRef({...f.args, tag: "mentra-v1", sha}), ref)
  assert.deepEqual(f.posts()[0].data, {ref: "refs/tags/mentra-v1", sha})
  assert.equal(f.calls[1].route, "repos/owner/repo/git/ref/tags/mentra-v1")
})

test("reuses a tag already at the commit and rejects one at another commit", async () => {
  const ref = {ref: "refs/tags/mentra-v1", object: {type: "commit", sha}}
  const reuse = fixture([ref])
  assert.deepEqual(await createTagRef({...reuse.args, tag: "mentra-v1", sha, lookupFirst: true}), ref)
  assert.equal(reuse.posts().length, 0)
  const moved = fixture([failure(422), {ref: "refs/tags/mentra-v1", object: {type: "commit", sha: other}}])
  await assert.rejects(createTagRef({...moved.args, tag: "mentra-v1", sha}), /already points to/)
  assert.deepEqual(moved.delays, [])
})

test("CLI reports only status for API failures", () => {
  try {
    execFileSync(process.execPath, [path.join(scriptsDir, "github-release-create.mjs"), "tag", "--repository", "owner/repo", "--tag", "x", "--sha", "main"], {stdio: "pipe", encoding: "utf8"})
    assert.fail("expected failure")
  } catch (error) {
    assert.equal(error.status, 1)
    assert.match(error.stderr, /Cannot create the GitHub tag \(Tag target must be a full commit SHA\)/)
  }
})

// Every release or tag created with GITHUB_TOKEN in this repository must go
// through the shared retry. Pushes to mirror repositories are excluded.
test("no workflow or release script creates a release or tag outside the shared module", () => {
  const files = [
    ...readdirSync(path.join(repoRoot, ".github/workflows")).map((name) => `.github/workflows/${name}`),
    ...readdirSync(scriptsDir)
      .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs") && name !== "github-release-create.mjs")
      .map((name) => `.github/scripts/${name}`),
  ]
  const creators = [
    /gh release create/,
    /createRelease\(\{\s*owner/,
    /--method[", ]+POST[^\n]*\/(releases|git\/refs)\b/,
    /\/(releases|git\/refs)`,\s*\{\s*method: "POST"/,
  ]
  for (const file of files) {
    const text = readFileSync(path.join(repoRoot, file), "utf8")
    for (const pattern of creators) assert.doesNotMatch(text, pattern, `${file} creates a release or tag directly`)
  }
})
