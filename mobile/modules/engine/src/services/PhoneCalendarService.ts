import * as Calendar from "expo-calendar"

import {MiniappErrorCode, type CalendarListResult} from "@mentra/miniapp"

import {
  calendarEventOverlapsWindow,
  type CalendarListRequest,
  normalizeCalendarEvent,
  PhoneCalendarError,
  validateCalendarListRequest,
} from "./PhoneCalendarHelpers"

export {PhoneCalendarError} from "./PhoneCalendarHelpers"

export async function listPhoneCalendarEvents(request: CalendarListRequest): Promise<CalendarListResult> {
  const {startsAt, endsAt, limit} = validateCalendarListRequest(request)
  const permission = await Calendar.getCalendarPermissionsAsync()
  if (permission.status !== "granted") {
    throw new PhoneCalendarError(
      MiniappErrorCode.PERMISSION_DENIED,
      "Calendar permission is not granted. Reopen the miniapp and grant calendar access.",
    )
  }

  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT)
  if (calendars.length === 0) return {events: [], truncated: false}

  const rawEvents = await Calendar.getEventsAsync(
    calendars.map((calendar) => calendar.id),
    startsAt,
    endsAt,
  )
  const events = rawEvents
    .map(normalizeCalendarEvent)
    .filter((event) => calendarEventOverlapsWindow(event, startsAt, endsAt))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || Date.parse(a.endsAt) - Date.parse(b.endsAt))

  return {
    events: events.slice(0, limit),
    truncated: events.length > limit,
  }
}
