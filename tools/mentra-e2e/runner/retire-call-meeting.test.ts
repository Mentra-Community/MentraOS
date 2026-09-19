import {expect, test} from "bun:test"
import {matchesOwnedMeeting, nativeCreatedMeeting} from "./retire-call-meeting"

const creation = `2026-09-16 21:52:02.762 I  Mentra[65893:e91a9] [com.facebook.react.log:javascript] '[MentraJSRouter] [com.mentra.call] console.log', [ '[mentra-call] [meeting] teams meeting created',
  { meetingId: 'opaque-test-id',
    owned: true,
    hasRef: true } ]`
const nativeContext = {pid: 65893, utcOffsetMinutes: 420}
const nativeStart = Date.parse("2026-09-17T04:52:00Z")
const nativeEnd = Date.parse("2026-09-17T04:52:10Z")

test("native cleanup proof binds the creation event to PID, local timezone and bounded attempt", () => {
  expect(nativeCreatedMeeting(creation, nativeContext, nativeStart, nativeEnd)).toBe("opaque-test-id")
  for (const context of [
    {...nativeContext, pid: 65894},
    {...nativeContext, utcOffsetMinutes: 0},
  ])
    expect(() => nativeCreatedMeeting(creation, context, nativeStart, nativeEnd)).toThrow()
  expect(() => nativeCreatedMeeting(creation, nativeContext, nativeEnd, nativeEnd + 10000)).toThrow()
  expect(() => nativeCreatedMeeting(creation, nativeContext, nativeStart, nativeStart + 90001)).toThrow()
})

test("native cleanup rejects duplicate creation, a different miniapp and missing ownership", () => {
  for (const log of [
    creation + "\n" + creation,
    creation.replace("[com.mentra.call]", "[com.mentra.notes]"),
    creation.replace("owned: true", "owned: false"),
    creation.replace("hasRef: true", "hasRef: false"),
    creation.replace("teams meeting created", "existing meeting restored"),
  ])
    expect(() => nativeCreatedMeeting(log, nativeContext, nativeStart, nativeEnd)).toThrow()
})

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
