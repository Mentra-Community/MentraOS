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
    assert.match(detail, /did not publish an installable app build/)
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

const catalogRow = (id, platform, title) => ({routineId: id, platform, definitionRevision: "a".repeat(40),
  definition: {id, title, platforms: [platform], execution: {module: "routine.ts", export: "createRoutine"}}})
const published = {...env, FINALIZE_RESULT: "success", RELEASE_IDENTITY: "3.3.0-dev.223", SHA: "a".repeat(40),
  TEST_RUN_INGEST_TOKEN: "synthetic-ingest-token", MAC_URL: "https://example.com/mac.zip", MOBILE_APK_URL: "https://example.com/app.apk"}
const catalogFetch = rows => async (url, init) => {
  assert.equal(url, "https://core.dev.us-west-2.mentraglass.com/api/internal/routine-catalog")
  assert.equal(init.headers.Authorization, "Bearer synthetic-ingest-token")
  return new Response(JSON.stringify({routines: rows}))
}
test("enrolled arbitrary IDs and titles link their exact published platform without implying a request", async () => {
  const calls = []
  const [block] = await coordinatedRoutineLinks(published, catalogFetch([
    catalogRow("new-id", "android", "A new <routine>"), catalogRow("new-id", "ios-on-mac", "A new <routine>")]), {
    select: async ({platform}) => {calls.push(platform); return {archive: {url: platform === "android" ? published.MOBILE_APK_URL : published.MAC_URL,
      sha256: (platform === "android" ? "d" : "e").repeat(64)}}},
  })
  assert.deepEqual(calls, ["android", "ios-on-mac"])
  assert.match(block.text.text, /Available device tests/)
  assert.match(block.text.text, /Tests require an explicit request/)
  assert.doesNotMatch(block.text.text, /Automatic request|No-glasses|execution and results are pending/)
  assert.match(block.text.text, /A new &lt;routine&gt; · Android/)
  const urls = [...block.text.text.matchAll(/<(https:[^|]+)\|Results for this exact build>/g)].map(match => new URL(match[1]).searchParams)
  assert.deepEqual(urls.map(params => params.get("platform")), ["android", "ios-on-mac"])
  assert.deepEqual(urls.map(params => params.get("archiveSha256")), ["d".repeat(64), "e".repeat(64)])
  assert.ok(urls.every(params => params.get("routineId") === "new-id" && params.get("headSha") === published.SHA))
})
test("one unverified platform cannot borrow another archive and repeated rows share one verification", async () => {
  const calls = []
  const [block] = await coordinatedRoutineLinks(published, catalogFetch([
    catalogRow("new-android", "android", "Phone coverage"), catalogRow("new-mac", "ios-on-mac", "Desktop coverage"),
    catalogRow("second-android", "android", "More phone coverage")]), {
    select: async ({platform}) => {calls.push(platform); return {archive: {url: published.MOBILE_APK_URL, sha256: "d".repeat(64)}}},
  })
  assert.deepEqual(calls, ["android", "ios-on-mac"])
  assert.match(block.text.text, /Desktop coverage · iOS on Mac — Published app download could not be verified; results link unavailable/)
  assert.equal([...block.text.text.matchAll(/\|Results for this exact build>/g)].length, 2)
})

test("catalog Slack section bounds escaped long titles and many definitions with an Admin overflow link", async () => {
  for (const titles of [Array(30).fill("Example screen check"), Array(30).fill("<&&>".repeat(500)), ["<&&>".repeat(500)]]) {
    const rows = titles.map((title, index) => catalogRow(`new-routine-${index}`, "android", title))
    const [block] = await coordinatedRoutineLinks(published, catalogFetch(rows), {select: async () => ({archive: {url: published.MOBILE_APK_URL, sha256: "d".repeat(64)}})})
    assert.ok(block.text.text.length <= 3000, block.text.text.length)
    assert.match(block.text.text, /Request pipeline/)
    if (rows.length > 1) assert.match(block.text.text, /routineCatalog=1\|View all available tests in Admin/)
    assert.doesNotMatch(block.text.text, /<&&>/)
    const links = [...block.text.text.matchAll(/<(https:[^|]+)\|[^>]+>/g)]
    assert.ok(links.every(match => new URL(match[1]).protocol === "https:"))
  }
})
test("empty or unavailable catalogs leave the release post useful without invented coverage", async () => {
  const [empty] = await coordinatedRoutineLinks(published, catalogFetch([]), {select: async () => assert.fail("No enrolled definitions")})
  assert.match(empty.text.text, /No device tests are currently enrolled/)
  const [missing] = await coordinatedRoutineLinks(published, async () => {throw new Error("private backend details")})
  assert.match(missing.text.text, /current routine catalog is unavailable/)
  assert.doesNotMatch(missing.text.text, /private backend details|\|Results for this exact build>/)
})
