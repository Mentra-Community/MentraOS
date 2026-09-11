/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappErrorCode} from "@mentra/miniapp"

import {
  calendarEventOverlapsWindow,
  extractHttpsLinks,
  normalizeCalendarEvent,
  PhoneCalendarError,
  validateCalendarListRequest,
} from "../PhoneCalendarHelpers"

describe("PhoneCalendarService", () => {
  test("validates and defaults a bounded query", () => {
    const result = validateCalendarListRequest({
      startsAt: "2026-07-16T12:00:00.000Z",
      endsAt: "2026-07-17T12:00:00.000Z",
    })
    expect(result.limit).toBe(50)
    expect(result.startsAt.toISOString()).toBe("2026-07-16T12:00:00.000Z")
  })

  test("rejects a query longer than 31 days", () => {
    expect(() =>
      validateCalendarListRequest({
        startsAt: "2026-07-01T00:00:00.000Z",
        endsAt: "2026-08-02T00:00:00.000Z",
      }),
    ).toThrow(PhoneCalendarError)
    try {
      validateCalendarListRequest({
        startsAt: "2026-07-01T00:00:00.000Z",
        endsAt: "2026-08-02T00:00:00.000Z",
      })
    } catch (error) {
      expect((error as PhoneCalendarError).code).toBe(MiniappErrorCode.INVALID_ARGUMENT)
    }
  })

  test("extracts and deduplicates HTTPS links", () => {
    expect(
      extractHttpsLinks(
        "https://meet.google.com/abc-defg-hij",
        "Room 1 (https://zoom.us/j/123).",
        "Join https://meet.google.com/abc-defg-hij or http://insecure.example.com",
      ),
    ).toEqual(["https://meet.google.com/abc-defg-hij", "https://zoom.us/j/123"])
  })

  test("normalizes a recurring occurrence with stable ISO fields", () => {
    expect(
      normalizeCalendarEvent({
        id: "event-1",
        calendarId: "calendar-1",
        title: "Standup",
        startDate: new Date("2026-07-17T10:00:00.000Z"),
        endDate: "2026-07-17T10:30:00.000Z",
        allDay: false,
        notes: "Join https://teams.microsoft.com/l/meetup-join/example",
      }),
    ).toMatchObject({
      id: "calendar-1:event-1:2026-07-17T10:00:00.000Z",
      startsAt: "2026-07-17T10:00:00.000Z",
      endsAt: "2026-07-17T10:30:00.000Z",
      links: ["https://teams.microsoft.com/l/meetup-join/example"],
    })
  })

  test("preserves an all-day event's calendar date in its timezone", () => {
    expect(
      normalizeCalendarEvent({
        id: "event-2",
        calendarId: "calendar-1",
        title: "Holiday",
        startDate: "2026-07-16T15:00:00.000Z",
        endDate: "2026-07-17T15:00:00.000Z",
        timeZone: "Asia/Tokyo",
        allDay: true,
      }),
    ).toMatchObject({
      id: "calendar-1:event-2:2026-07-17T00:00:00.000+09:00",
      startsAt: "2026-07-17T00:00:00.000+09:00",
      endsAt: "2026-07-18T00:00:00.000+09:00",
      timezone: "Asia/Tokyo",
      allDay: true,
    })
  })

  test("keeps date-only all-day values on their intended date", () => {
    const event = normalizeCalendarEvent({
      id: "event-3",
      calendarId: "calendar-1",
      startDate: "2026-03-08",
      endDate: "2026-03-09",
      timeZone: "America/Los_Angeles",
      allDay: true,
    })

    expect(event.startsAt).toBe("2026-03-08T00:00:00.000-08:00")
    expect(event.endsAt).toBe("2026-03-09T00:00:00.000-07:00")
  })

  test("enforces a half-open calendar window", () => {
    const startsAt = new Date("2026-07-17T10:00:00.000Z")
    const endsAt = new Date("2026-07-17T11:00:00.000Z")
    const event = (eventStartsAt: string, eventEndsAt: string) => ({
      id: "event",
      calendarId: "calendar",
      title: "Meeting",
      startsAt: eventStartsAt,
      endsAt: eventEndsAt,
      allDay: false,
      links: [],
    })

    expect(
      calendarEventOverlapsWindow(event("2026-07-17T09:30:00.000Z", "2026-07-17T10:30:00.000Z"), startsAt, endsAt),
    ).toBe(true)
    expect(
      calendarEventOverlapsWindow(event("2026-07-17T11:00:00.000Z", "2026-07-17T11:30:00.000Z"), startsAt, endsAt),
    ).toBe(false)
    expect(
      calendarEventOverlapsWindow(event("2026-07-17T09:30:00.000Z", "2026-07-17T10:00:00.000Z"), startsAt, endsAt),
    ).toBe(false)
  })
})
