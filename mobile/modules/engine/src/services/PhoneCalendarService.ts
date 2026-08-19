import * as Calendar from "expo-calendar"
import {Platform} from "react-native"
import {check, PERMISSIONS, RESULTS} from "react-native-permissions"

import {MiniappErrorCode, type CalendarListResult} from "@mentra/miniapp"

import {
  calendarEventOverlapsWindow,
  type CalendarListRequest,
  normalizeCalendarEvent,
  PhoneCalendarError,
  validateCalendarListRequest,
} from "./PhoneCalendarHelpers"

export {PhoneCalendarError} from "./PhoneCalendarHelpers"

/**
 * expo-calendar reports anything below EventKit full access as not granted,
 * so distinguish the states the user can actually fix. "Reopen the miniapp"
 * is only true while the permission is undetermined — once iOS has resolved
 * it (denied or write-only/limited), only Settings can change it.
 */
async function calendarPermissionMessage(status: Calendar.PermissionStatus): Promise<string> {
  if (status === Calendar.PermissionStatus.UNDETERMINED) {
    return "Calendar permission has not been granted yet. Reopen the miniapp and allow calendar access."
  }
  if (Platform.OS === "ios") {
    const writeOnly = await check(PERMISSIONS.IOS.CALENDARS_WRITE_ONLY).catch(() => null)
    if (writeOnly === RESULTS.GRANTED || writeOnly === RESULTS.LIMITED) {
      return 'Calendar access is limited to write-only. Enable "Full Access" for Mentra in Settings › Privacy & Security › Calendars.'
    }
    return "Calendar access is denied. Enable it for Mentra in Settings › Privacy & Security › Calendars."
  }
  return "Calendar access is denied. Enable the Calendar permission for Mentra in your phone's app settings."
}

export async function listPhoneCalendarEvents(request: CalendarListRequest): Promise<CalendarListResult> {
  const {startsAt, endsAt, limit} = validateCalendarListRequest(request)
  const permission = await Calendar.getCalendarPermissionsAsync()
  if (permission.status !== "granted") {
    throw new PhoneCalendarError(MiniappErrorCode.PERMISSION_DENIED, await calendarPermissionMessage(permission.status))
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
