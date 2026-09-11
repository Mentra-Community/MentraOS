import assert from "node:assert/strict"
import {mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {compareVersions, latestFlipDecision, npmMembersFromPlan, promoteNpmLatest} from "./promote-npm-latest.mjs"
import {createReleasePlan, loadReleaseFamily} from "./release-family.mjs"

const family = loadReleaseFamily()
const plan = createReleasePlan({
  family,
  channel: "production",
  sourceCommit: "a".repeat(40),
  nativeBuildNumber: 310000057,
})
const version = plan.releaseIdentity
const candidateTag = `candidate-${version}`

test("orders plain versions and treats a prerelease as older than its plain release", () => {
  assert.equal(compareVersions("3.1.0", "3.1.0"), 0)
  assert.equal(compareVersions("3.2.0", "3.1.9"), 1)
  assert.equal(compareVersions("3.1.0-beta.57", "3.1.0"), -1)
  assert.equal(compareVersions("3.1.0", "3.1.0-beta.57"), 1)
  assert.throws(() => compareVersions("latest", "3.1.0"), /Cannot compare/)
})

test("moves latest only from a published candidate tag and never backwards", () => {
  assert.deepEqual(latestFlipDecision({version, candidateTag, distTags: {latest: version}}), {
    action: "reused",
    previousLatest: version,
  })
  assert.deepEqual(latestFlipDecision({version, candidateTag, distTags: {[candidateTag]: version, beta: "x"}}), {
    action: "published",
    previousLatest: null,
  })
  assert.deepEqual(latestFlipDecision({version, candidateTag, distTags: {[candidateTag]: version, latest: "3.0.2"}}), {
    action: "published",
    previousLatest: "3.0.2",
  })
  assert.throws(() => latestFlipDecision({version, candidateTag, distTags: {latest: "3.0.2"}}), /run the publish phase/)
  assert.throws(
    () => latestFlipDecision({version, candidateTag, distTags: {[candidateTag]: version, latest: "3.2.0"}}),
    /refusing to move it back/,
  )
})

test("selects the npm members of the frozen plan in publication order", () => {
  const members = npmMembersFromPlan(plan)
  assert.ok(members.includes("@mentra/engine"))
  assert.ok(!members.includes("mentraos"))
  assert.ok(members.indexOf("@mentra/bluetooth-sdk") < members.indexOf("@mentra/engine"))
  assert.throws(() => npmMembersFromPlan({channel: "production"}), /release plan is required/)
})

function registry(initialTags) {
  const tags = new Map(Object.entries(initialTags).map(([name, entries]) => [name, new Map(entries)]))
  const commands = []
  return {
    commands,
    view(spec, field) {
      if (field === "dist.integrity") return JSON.stringify(`sha512-${spec}`)
      const name = spec
      return JSON.stringify(Object.fromEntries(tags.get(name) || []))
    },
    exec(command, args) {
      commands.push(`${command} ${args.join(" ")}`)
      const [, action, coordinate, tag] = args
      if (action === "add") {
        const name = coordinate.slice(0, coordinate.lastIndexOf("@"))
        tags.get(name).set(tag, coordinate.slice(name.length + 1))
      }
      if (action === "rm") tags.get(coordinate).delete(tag)
    },
  }
}

test("flips latest for every npm member, reads it back, and retires the candidate tag", () => {
  const members = npmMembersFromPlan(plan)
  const initial = Object.fromEntries(
    members.map((name) => [
      name,
      [
        [candidateTag, version],
        ["latest", "3.0.0"],
      ],
    ]),
  )
  initial["@mentra/engine"] = [["latest", version]]
  const fake = registry(initial)
  const outputDir = mkdtempSync(path.join(tmpdir(), "npm-latest-"))
  const result = promoteNpmLatest({
    plan,
    npmTag: candidateTag,
    outputDir,
    view: fake.view,
    exec: fake.exec,
    log: () => {},
  })
  assert.equal(result.publications["@mentra/engine"].npm.status, "reused")
  assert.equal(result.publications["@mentra/bluetooth-sdk"].npm.status, "published")
  assert.equal(result.publications["@mentra/bluetooth-sdk"].npm.previousLatest, "3.0.0")
  assert.ok(fake.commands.includes(`npm dist-tag add @mentra/bluetooth-sdk@${version} latest`))
  assert.ok(fake.commands.includes(`npm dist-tag rm @mentra/bluetooth-sdk ${candidateTag}`))
  assert.ok(!fake.commands.some((command) => command.includes("@mentra/engine@")))
  const written = JSON.parse(readFileSync(path.join(outputDir, "npm-latest.json"), "utf8"))
  assert.equal(written.releaseSetId, plan.releaseSetId)
  assert.equal(Object.keys(written.publications).length, members.length)
})

test("refuses unpublished versions and does nothing in a dry run", () => {
  const members = npmMembersFromPlan(plan)
  const fake = registry(Object.fromEntries(members.map((name) => [name, [[candidateTag, version]]])))
  const dry = promoteNpmLatest({
    plan,
    npmTag: candidateTag,
    dryRun: true,
    view: fake.view,
    exec: fake.exec,
    log: () => {},
  })
  assert.equal(dry.publications["@mentra/engine"].npm.status, "built")
  assert.deepEqual(fake.commands, [])

  assert.throws(
    () =>
      promoteNpmLatest({
        plan,
        npmTag: candidateTag,
        view: (spec, field) => (field === "dist.integrity" ? null : "{}"),
        exec: fake.exec,
      }),
    /is not published on npm/,
  )
  assert.throws(
    () => promoteNpmLatest({plan: {...plan, channel: "beta"}, npmTag: candidateTag}),
    /Only a production plan/,
  )
  assert.throws(() => promoteNpmLatest({plan, npmTag: undefined, view: fake.view}), /explicit candidate dist-tag/)
})

test("moves nothing when any member would be unpublished or downgraded", () => {
  const members = npmMembersFromPlan(plan)
  const ahead = registry(
    Object.fromEntries(
      members.map((name, index) => [
        name,
        index === members.length - 1
          ? [["latest", "3.2.0"]]
          : [
              [candidateTag, version],
              ["latest", "3.0.0"],
            ],
      ]),
    ),
  )
  assert.throws(
    () => promoteNpmLatest({plan, npmTag: candidateTag, view: ahead.view, exec: ahead.exec, log: () => {}}),
    /run the publish phase first|refusing to move it back/,
  )
  assert.deepEqual(ahead.commands, [])

  const missing = registry(Object.fromEntries(members.map((name) => [name, [[candidateTag, version]]])))
  const last = members.at(-1)
  assert.throws(
    () =>
      promoteNpmLatest({
        plan,
        npmTag: candidateTag,
        view: (spec, field) =>
          field === "dist.integrity" && spec.startsWith(`${last}@`) ? null : missing.view(spec, field),
        exec: missing.exec,
        log: () => {},
      }),
    /is not published on npm/,
  )
  assert.deepEqual(missing.commands, [])
})
