import assert from "node:assert/strict"
import test from "node:test"
import {SLACK_SECTION_LIMIT, slackRoutineSection, slackRoutineText} from "./slack-routine-section.mjs"

test("bounded routine rendering preserves whole escaped strings and links", () => {
  assert.equal(slackRoutineText("&<>\n", 10), "&amp;&lt;&gt; ")
  assert.equal(slackRoutineText("💡".repeat(241)).length, 479)
  const lines = Array.from({length: 30}, (_, index) => `${slackRoutineText("&<>".repeat(1000))} · <https://admin.dev.mentraglass.com/?testRun=request-${index}|Result>`)
  const text = slackRoutineSection({heading: "*Tests*", lines, footer: "Footer", overflowUrl: "https://admin.dev.mentraglass.com/?testRuns=1", overflowLabel: "All results"})
  assert.ok(text.length <= SLACK_SECTION_LIMIT)
  assert.match(text, /\n<https:\/\/admin.dev.mentraglass.com\/\?testRuns=1\|All results>\nFooter$/)
  assert.equal(text.split("\n")[1], lines[0])
  const renderedRows = text.split("\n").slice(1, -2)
  assert.deepEqual(renderedRows, lines.slice(0, renderedRows.length))
  assert.equal((text.match(/<https:[^>]+>/g) ?? []).length, renderedRows.length + 1)
})
