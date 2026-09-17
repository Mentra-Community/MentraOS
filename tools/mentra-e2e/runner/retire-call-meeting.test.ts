import {expect, test} from "bun:test"
import {matchesOwnedMeeting} from "./retire-call-meeting"

test("a nearby meeting with the same subject and time is not proof of ownership", () => {
  const time = Date.parse("2026-09-17T00:00:00Z")
  const meeting = {
    id: "test-id",
    subject: "Mentra Call",
    startDateTime: new Date(time).toISOString(),
    joinMeetingIdSettings: {joinMeetingId: "123 456", passcode: "test-pass"},
  }
  const link = "https://teams.microsoft.com/meet/123456?p=test-pass"
  expect(matchesOwnedMeeting(meeting, "test-id", link, time - 1000, time + 1000)).toBe(true)
  expect(matchesOwnedMeeting(meeting, "other-id", link, time - 1000, time + 1000)).toBe(false)
  expect(matchesOwnedMeeting(meeting, "test-id", link.replace("123456", "999999"), time - 1000, time + 1000)).toBe(
    false,
  )
  expect(
    matchesOwnedMeeting(meeting, "test-id", link.replace("test-pass", "other-pass"), time - 1000, time + 1000),
  ).toBe(false)
  expect(matchesOwnedMeeting(meeting, "test-id", link, time + 1, time + 1000)).toBe(false)
  expect(
    matchesOwnedMeeting({...meeting, joinMeetingIdSettings: undefined}, "test-id", link, time - 1000, time + 1000),
  ).toBe(false)
})
