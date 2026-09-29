import assert from "node:assert/strict"
import test from "node:test"
import {coordinatedRoutineLinks, releaseFailureDetail} from "./coordinated-downloads-slack.mjs"

const env = {BRANCH: "dev", REPOSITORY: "Mentra-Community/MentraOS", RUN_ID: "100", RUN_ATTEMPT: "2", FINALIZE_RESULT: "skipped"}
const response = jobs => new Response(JSON.stringify({jobs}))
const ios = {id: 123, name: "Build and distribute MentraOS mobile apps / Build and distribute coordinated iOS app", conclusion: "failure",
  steps: [{name: "Check Mapbox SDK download authentication", conclusion: "failure"}]}

test("dev and staging posts name the failed iOS job and step with a direct link", async () => {
  for (const branch of ["dev", "staging"]) {
    const [block] = await coordinatedRoutineLinks({...env, BRANCH: branch}, async url => {
      assert.equal(url, "https://api.github.com/repos/Mentra-Community/MentraOS/actions/runs/100/attempts/2/jobs?per_page=100")
      return response([{id: 122, name: "Other release gate", conclusion: "failure"}, ios])
    })
    assert.match(block.text.text, /Not requested: iOS\/Mac build failed during “Check Mapbox SDK download authentication”/)
    assert.match(block.text.text, /actions\/runs\/100\/job\/123\|View failed job/)
    assert.doesNotMatch(block.text.text, /no verified successful Mac publication|archive receipt/)
  }
})

test("early preparation failure points at the preflight before any Mac build exists", async () => {
  const detail = await releaseFailureDetail(env, async () => response([{...ios, name: "Build mobile / Prepare immutable mobile release"}]))
  assert.match(detail, /Prepare immutable mobile release failed during “Check Mapbox SDK download authentication”/)
  assert.match(detail, /\/job\/123/)
})

test("API outages and missing jobs retain a useful release link without blocking Slack", async () => {
  for (const fetchImpl of [async () => new Response("private provider error", {status: 403}), async () => response([]),
    async () => { throw new Error("private provider error") }]) {
    const detail = await releaseFailureDetail(env, fetchImpl)
    assert.match(detail, /did not publish an installable iOS\/Mac build/)
    assert.match(detail, /\/attempts\/2\|View release jobs/)
    assert.doesNotMatch(detail, /private provider error/)
  }
})

test("cancellation and publication failures are explicit and escape Slack markup", async () => {
  const cancelled = await releaseFailureDetail(env, async () => response([{...ios, conclusion: "cancelled", steps: []}]))
  assert.match(cancelled, /iOS\/Mac build was cancelled/)
  const failed = await releaseFailureDetail({...env, MAC_URL: "https://example.com/mac.zip"}, async () => response([
    {...ios, name: "Publish / Finalize release", steps: [{name: "Verify <metadata> & build", conclusion: "failure"}]},
  ]))
  assert.match(failed, /Finalize release failed during “Verify &lt;metadata&gt; &amp; build”/)
  assert.doesNotMatch(failed, /iOS\/Mac build failed/)
})
