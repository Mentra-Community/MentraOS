import {describe, expect, test} from "bun:test"
import {classifyTeams, teamsMeetingUrl, hasAdvancingVideo, hasDecodedVideo} from "./teams-browser"

describe("Teams browser qualification boundaries", () => {
  test("a lobby takes precedence over previews and other call controls", () => {
    expect(classifyTeams({lobby: true, leave: true, join: true, signin: false})).toBe("lobby")
    expect(classifyTeams({lobby: false, leave: false, join: true, signin: false})).toBe("prejoin")
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
