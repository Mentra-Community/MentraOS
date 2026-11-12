import assert from "node:assert/strict"
import {mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {
  compareVersions,
  latestDecision,
  npmMembersFromPlan,
  preflightNpmLatest,
  verifyNpmLatest,
} from "./npm-latest.mjs"
import {createReleasePlan, familyBuildNumber, loadReleaseFamily} from "./release-family.mjs"

const family = loadReleaseFamily()
const plan = createReleasePlan({
  family,
  channel: "production",
  sourceCommit: "a".repeat(40),
  nativeBuildNumber: familyBuildNumber(family.familyBaseVersion, 57),
})
const version = plan.releaseIdentity
// A version guaranteed to be newer than `version` however the repository's own
// current release identity happens to be set, so these fixtures never
// coincidentally collide with the real value under test.
const [major, minor, patch] = version.split(".").map(Number)
const newerVersion = `${major}.${minor}.${patch + 1}`
const members = npmMembersFromPlan(plan)

test("orders plain versions and treats a prerelease as older than its plain release", () => {
  assert.equal(compareVersions("3.1.0", "3.1.0"), 0)
  assert.equal(compareVersions("3.2.0", "3.1.9"), 1)
  assert.equal(compareVersions("3.1.0-beta.57", "3.1.0"), -1)
  assert.equal(compareVersions("3.1.0", "3.1.0-beta.57"), 1)
  assert.throws(() => compareVersions("latest", "3.1.0"), /Cannot compare/)
})

test("publishes a new version to latest only when latest is not ahead of it", () => {
  const coordinate = `@mentra/engine@${version}`
  assert.deepEqual(latestDecision({coordinate, version, published: false, distTags: {latest: "3.0.2", beta: "x"}}), {
    action: "publish",
    previousLatest: "3.0.2",
  })
  assert.deepEqual(latestDecision({coordinate, version, published: false, distTags: {}}), {
    action: "publish",
    previousLatest: null,
  })
  assert.deepEqual(latestDecision({coordinate, version, published: true, distTags: {latest: version}}), {
    action: "reused",
    previousLatest: version,
  })
  assert.throws(
    () => latestDecision({coordinate, version, published: false, distTags: {latest: newerVersion}}),
    /refusing to release .* over it/,
  )
  // Retrying an older release after a newer one shipped must never suggest
  // moving latest back to it.
  for (const published of [true, false]) {
    assert.throws(
      () => latestDecision({coordinate, version, published, distTags: {latest: newerVersion}}),
      (error) => /refusing to release/.test(error.message) && !/dist-tag add/.test(error.message),
    )
  }
  // A version that reached npm without `latest` (the retired candidate
  // dist-tag flow) needs a maintainer, never a silent reuse.
  assert.throws(
    () =>
      latestDecision({
        coordinate,
        version,
        published: true,
        distTags: {latest: "3.0.2", [`candidate-${version}`]: version},
      }),
    new RegExp(`npm dist-tag add ${coordinate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} latest`),
  )
})

test("selects the npm members of the frozen plan in publication order", () => {
  assert.ok(members.includes("@mentra/engine"))
  assert.ok(!members.includes("mentraos"))
  assert.ok(members.indexOf("@mentra/bluetooth-sdk") < members.indexOf("@mentra/engine"))
  assert.throws(() => npmMembersFromPlan({channel: "production"}), /release plan is required/)
})

// A registry fake: `published` maps names to the integrity of `version`, and
// `tags` to their dist-tags.
function registry({published = {}, tags = {}}) {
  return {
    published: new Map(Object.entries(published)),
    tags: new Map(Object.entries(tags)),
    view(spec, field) {
      if (field === "dist.integrity") {
        const name = spec.slice(0, spec.lastIndexOf("@"))
        return this.published.has(name) ? JSON.stringify(this.published.get(name)) : null
      }
      return JSON.stringify(this.tags.get(spec) || {})
    },
  }
}

function allMembers(value) {
  return Object.fromEntries(members.map((name) => [name, typeof value === "function" ? value(name) : value]))
}

test("preflight decides the whole family and records the previous latest", () => {
  const engine = "@mentra/engine"
  const fake = registry({
    published: {[engine]: `sha512-${engine}`},
    tags: allMembers((name) => (name === engine ? {latest: version} : {latest: "3.0.0"})),
  })
  const outputDir = mkdtempSync(path.join(tmpdir(), "npm-latest-"))
  const result = preflightNpmLatest({plan, outputDir, view: (...args) => fake.view(...args)})
  assert.deepEqual(result.members[engine], {action: "reused", previousLatest: version})
  assert.deepEqual(result.members["@mentra/bluetooth-sdk"], {action: "publish", previousLatest: "3.0.0"})
  const written = JSON.parse(readFileSync(path.join(outputDir, "npm-preflight.json"), "utf8"))
  assert.equal(written.releaseSetId, plan.releaseSetId)
  assert.equal(Object.keys(written.members).length, members.length)
})

test("preflight stops before publishing when any member is ahead or published without latest", () => {
  const last = members.at(-1)
  const ahead = registry({tags: allMembers((name) => ({latest: name === last ? newerVersion : "3.0.0"}))})
  assert.throws(() => preflightNpmLatest({plan, view: (...args) => ahead.view(...args)}), /refusing to release/)

  const stranded = registry({
    published: {[last]: `sha512-${last}`},
    tags: allMembers({latest: "3.0.0"}),
  })
  assert.throws(() => preflightNpmLatest({plan, view: (...args) => stranded.view(...args)}), /npm dist-tag add/)

  assert.throws(() => preflightNpmLatest({plan: {...plan, channel: "beta"}}), /Only a production plan/)
})

function publicationsFor(status = "published") {
  return {
    releaseSetId: plan.releaseSetId,
    publications: allMembers((name) => ({
      npm: {
        status,
        coordinate: `${name}@${version}`,
        integrity: `sha512-${name}`,
        provenanceUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/1",
      },
    })),
  }
}

function preflightFor() {
  return {releaseSetId: plan.releaseSetId, members: allMembers({action: "publish", previousLatest: "3.0.0"})}
}

test("verify waits for npm to serve latest at the published bytes and records it", () => {
  const fake = registry({
    published: allMembers((name) => `sha512-${name}`),
    tags: allMembers({latest: version}),
  })
  // npm acknowledges the publish, but the next reads still serve the previous
  // latest for a while, as npm does.
  const stale = new Map(members.map((name) => [name, 2]))
  let sleeps = 0
  const outputDir = mkdtempSync(path.join(tmpdir(), "npm-latest-"))
  const result = verifyNpmLatest({
    plan,
    preflight: preflightFor(),
    publications: publicationsFor(),
    outputDir,
    view(spec, field) {
      if (field === "dist-tags" && stale.get(spec) > 0) {
        stale.set(spec, stale.get(spec) - 1)
        return JSON.stringify({latest: "3.0.0"})
      }
      return fake.view(spec, field)
    },
    log: () => {},
    readbackAttempts: 4,
    sleep: () => {
      sleeps += 1
    },
  })
  assert.equal(sleeps, 2 * members.length)
  const engine = result.publications["@mentra/engine"].npm
  assert.equal(engine.status, "published")
  assert.equal(engine.tag, "latest")
  assert.equal(engine.previousLatest, "3.0.0")
  assert.equal(engine.integrity, "sha512-@mentra/engine")
  const written = JSON.parse(readFileSync(path.join(outputDir, "npm-latest.json"), "utf8"))
  assert.equal(Object.keys(written.publications).length, members.length)
})

test("verify refuses a latest that never moves, foreign bytes, or a missing publication", () => {
  const stuck = registry({published: allMembers((name) => `sha512-${name}`), tags: allMembers({latest: "3.0.0"})})
  let sleeps = 0
  assert.throws(
    () =>
      verifyNpmLatest({
        plan,
        preflight: preflightFor(),
        publications: publicationsFor(),
        view: (...args) => stuck.view(...args),
        log: () => {},
        readbackAttempts: 3,
        sleep: () => {
          sleeps += 1
        },
      }),
    /latest reads back as "3\.0\.0" after 10s, expected/,
  )
  assert.equal(sleeps, 2)

  const foreign = registry({published: allMembers("sha512-other"), tags: allMembers({latest: version})})
  assert.throws(
    () =>
      verifyNpmLatest({
        plan,
        preflight: preflightFor(),
        publications: publicationsFor(),
        view: (...args) => foreign.view(...args),
      }),
    /not the published/,
  )

  const served = registry({published: allMembers((name) => `sha512-${name}`), tags: allMembers({latest: version})})
  assert.throws(
    () =>
      verifyNpmLatest({
        plan,
        preflight: preflightFor(),
        publications: publicationsFor("built"),
        view: (...args) => served.view(...args),
      }),
    /has no publication record from this run/,
  )
  assert.throws(
    () =>
      verifyNpmLatest({
        plan,
        preflight: {...preflightFor(), releaseSetId: "other"},
        publications: publicationsFor(),
        view: (...args) => served.view(...args),
      }),
    /must belong to the release plan/,
  )
})
