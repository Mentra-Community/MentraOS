import assert from "node:assert/strict"
import test from "node:test"
import {renderPrRoutineResult, resolvePrRoutineResults, publishPrRoutineResult} from "./pr-routine-result.mjs"
import {routineFixture, terminalRoutineFixture} from "./routine-api-fixture.mjs"
const context = {repo: {owner: "Mentra-Community", repo: "MentraOS"}, eventName: "workflow_run", ref: "refs/heads/dev"}

test("PR comment uses unknown-to-client frozen title/platform and actual lifecycle outcome", () => {
  const f = routineFixture({routineId: "example.new-test", platform: "android"}), plan = renderPrRoutineResult(f.detail)
  assert.match(plan.body, /Example screen check/); assert.match(plan.body, /example.new-test/); assert.match(plan.body, /Platform: `android`/)
  assert.equal(plan.pr, 12); assert.equal(plan.requestId, f.request.requestId)
  f.detail.result.uploadsComplete = false; assert.match(renderPrRoutineResult(f.detail).body, /upload-incomplete/)
  f.detail.result.run.build.headSha = "f".repeat(40); assert.throws(() => renderPrRoutineResult(f.detail), /differs/)
  assert.equal(resolvePrRoutineResults({details: [routineFixture({channel: "dev"}).detail]}).length, 0)
})
test("PR notification retries reconcile marker after an uncertain send and retain one comment", async () => {
  const f = routineFixture(), plan = renderPrRoutineResult(f.detail), comments = [], writes = []
  let uncertain = true
  const github = {paginate: async () => comments, rest: {issues: {listComments: () => {}, createComment: async input => {
    writes.push(input); const data = {id: 1, body: input.body, user: {login: "github-actions[bot]", type: "Bot"}}; comments.push(data)
    if (uncertain) {uncertain = false; throw new Error("accepted response lost")}; return {data}
  }, updateComment: async input => {writes.push(input); comments[0].body = input.body}}}}
  await assert.rejects(publishPrRoutineResult({github, context, plan}), /response lost/)
  assert.equal((await publishPrRoutineResult({github, context, plan})).status, "unchanged")
  assert.equal(writes.length, 1)
  comments.push({...comments[0], id: 2}); await assert.rejects(publishPrRoutineResult({github, context, plan}), /Duplicate/)
})

test("terminal PR request comment shows truthful receipt and no recording or framework checks", () => {
  for (const status of ["not-run", "cancelled"]) {
    const f = terminalRoutineFixture({status}), plan = renderPrRoutineResult(f.detail)
    assert.match(plan.body, new RegExp(status)); assert.match(plan.body, /No framework result has been published/)
    assert.match(plan.body, /\[Request receipt\].*testRun=example-request/)
    assert.doesNotMatch(plan.body, /Recording and full result|\| Setup \||recorded candidate/)
    assert.match(plan.body, new RegExp(f.request.input.definitionRevision))
  }
})
