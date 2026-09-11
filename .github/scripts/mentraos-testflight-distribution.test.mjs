import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import test from "node:test"
import {validateMentraosTestflightDistribution} from "./mentraos-testflight-distribution.mjs"

const plan = {channel: "beta", native: {testflight: {group: "Mentra Staging Public", audience: "external"}}}
const record = {
  group: "Mentra Staging Public", audience: "external", status: "submitted", buildId: "build-1",
  installUrl: "https://testflight.apple.com/join/public123", reviewState: "WAITING_FOR_REVIEW",
}
test("public TestFlight separates submitted, approved and skipped distribution", () => {
  const validate = (value) => validateMentraosTestflightDistribution(plan, record.group, value)
  assert.equal(validate(record).status, "submitted")
  assert.equal(validate({...record, status: "available", reviewState: "APPROVED"}).status, "available")
  assert.equal(validate({...record, status: "skipped", skipReason: "external_review_pending"}).status, "skipped")
  for (const change of [
    {audience: "internal"}, {group: "Mentra Dev"}, {buildId: ""}, {status: "skipped"},
    {status: "available"}, {installUrl: "https://appstoreconnect.apple.com/apps"},
  ]) assert.throws(() => validate({...record, ...change}))
  assert.throws(() => validateMentraosTestflightDistribution({...plan, channel: "dev"}, record.group, record))
})
test("dev must remain internal and available", () => {
  const dev = {channel: "dev", native: {}}
  const internal = {...record, group: "Mentra Dev", audience: "internal", status: "available", installUrl: "https://appstoreconnect.apple.com/apps"}
  assert.equal(validateMentraosTestflightDistribution(dev, internal.group, internal).audience, "internal")
  assert.throws(() => validateMentraosTestflightDistribution(dev, internal.group, {...internal, status: "submitted"}))
})
test("coordinator freezes public-beta intent and mobile reports review state", () => {
  const coordinator = readFileSync(new URL("../workflows/coordinated-release.yml", import.meta.url), "utf8")
  const planCommands = coordinator.replace(/\\\r?\n/g, " ").split("\n")
    .filter((line) => /node\s+\.github\/scripts\/create-release-plan\.mjs\b/.test(line))
  assert.ok(planCommands.some((command) => /--output\s+"\$output"/.test(command)), "initial/retry plan generation is present")
  assert.ok(planCommands.some((command) => /--output\s+release-plan\.json\b/.test(command)), "deterministic verification is present")
  for (const command of planCommands) assert.match(command, /--public-beta-testflight\s+true\b/)
  assert.match(coordinator, /testflight_group=Mentra Staging Public/)
  assert.match(coordinator, /testflight_audience=external/)
  assert.match(coordinator, /testflight_audience=internal/)
  const mobile = readFileSync(new URL("../workflows/reusable-coordinated-mobile.yml", import.meta.url), "utf8")
  const audienceInput = mobile.match(/^([ \t]*)testflight_audience:[ \t]*\n([\s\S]*?)(?=^\1\S|(?![\s\S]))/m)?.[2]
  assert.ok(audienceInput, "TestFlight audience input is present")
  assert.match(audienceInput, /^\s*required:\s*false\s*(?:#.*)?$/m)
  assert.match(audienceInput, /^\s*default:\s*internal\s*(?:#.*)?$/m)
  assert.match(mobile, /testflight-preflight/)
  assert.match(mobile, /--allow-rejected-override false/)
  assert.match(mobile, /--distribution-status/)
  assert.match(coordinator, /TESTFLIGHT_INSTALL_URL: \$\{\{ needs\.mobile\.outputs\.testflight_install_url/)
})
