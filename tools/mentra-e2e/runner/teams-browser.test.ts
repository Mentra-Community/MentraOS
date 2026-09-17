import {describe, expect, test} from "bun:test"
import {chromium} from "playwright-core"
import {classifyTeams, teamsMeetingUrl, hasAdvancingVideo, hasDecodedVideo, reachTeamsJoinState} from "./teams-browser"

describe("Teams browser qualification boundaries", () => {
  test("a lobby takes precedence over previews and other call controls", () => {
    expect(classifyTeams({lobby: true, leave: true, join: true, signin: false})).toBe("lobby")
    expect(classifyTeams({lobby: false, leave: false, join: true, signin: false})).toBe("prejoin")
    expect(classifyTeams({lobby: false, leave: false, left: true, join: true, signin: false})).toBe("prejoin")
    expect(classifyTeams({lobby: false, leave: false, left: true, join: false, signin: false})).toBe("left")
    expect(classifyTeams({lobby: false, leave: true, join: false, signin: false})).toBe("connected")
  })
  test("only generated work Teams HTTPS links can launch a test", () => {
    expect(teamsMeetingUrl("https://teams.microsoft.com/meet/123?p=test")).toContain("/meet/123")
    for (const url of [
      "http://teams.microsoft.com/meet/123",
      "https://teams.microsoft.com.evil.test/meet/123",
      "https://user:secret@teams.microsoft.com/meet/123",
      "https://teams.microsoft.com/",
      "https://teams.microsoft.com/meet/123/unrelated",
      "file:///tmp/test",
    ])
      expect(() => teamsMeetingUrl(url)).toThrow()
  })
})

test("remote video may adapt resolution but must advance decoded playback", () => {
  const before = [{width: 848, height: 480, time: 0.414, paused: false, readyState: 4}]
  expect(hasAdvancingVideo(before, [{width: 960, height: 540, time: 5.388, paused: false, readyState: 4}])).toBe(true)
  expect(hasAdvancingVideo(before, [{...before[0], time: 0.414}])).toBe(false)
  expect(hasAdvancingVideo(before, [{...before[0], time: 5, paused: true}])).toBe(false)
  expect(hasAdvancingVideo([], before)).toBe(false)
})

test("a participant without decoded video is not a playback baseline", () => {
  const frame = {width: 960, height: 540, time: 4.682, paused: false, readyState: 4}
  expect(hasDecodedVideo([])).toBe(false)
  expect(hasDecodedVideo([{...frame, width: 0, height: 0, readyState: 0}])).toBe(false)
  expect(hasDecodedVideo([frame])).toBe(true)
  expect(hasAdvancingVideo([], [frame])).toBe(false)
  expect(hasAdvancingVideo([{...frame, paused: true}], [{...frame, time: 10}])).toBe(false)
})

// Exercise delayed UI transitions in a fresh local page, without devices or a meeting.
test.skipIf(process.env.MENTRA_E2E_BROWSER_TEST !== "1")(
  "rejoin waits past a lingering left page and handles direct admission",
  async () => {
    const browser = await chromium.launch({channel: "chrome", headless: true, chromiumSandbox: true})
    try {
      const page = await browser.newPage()
      await page.setContent("<button>Rejoin meeting</button>")
      let settled = false
      const ready = reachTeamsJoinState(page, async () => {}, "rejoin-", true)
      ready.then(() => {
        settled = true
      })
      await Bun.sleep(100)
      expect(settled).toBe(false)
      await page.setContent("<button>Rejoin meeting</button><button>Join now</button>")
      expect(await ready).toBe("prejoin")
      await page.setContent("<h1>Someone will let you in shortly</h1><button>Leave</button>")
      expect(await reachTeamsJoinState(page, async () => {}, "rejoin-", true)).toBe("lobby")
      await page.setContent("<button>Leave</button>")
      expect(await reachTeamsJoinState(page, async () => {}, "rejoin-", true)).toBe("connected")
    } finally {
      await browser.close()
    }
  },
  15000,
)
