import {MiniappErrorCode, type CalendarEvent} from "@mentra/miniapp"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000

export interface CalendarListRequest {
  startsAt?: unknown
  endsAt?: unknown
  limit?: unknown
}

export class PhoneCalendarError extends Error {
  constructor(
    public readonly code: MiniappErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "PhoneCalendarError"
  }
}

export interface ValidatedCalendarListRequest {
  startsAt: Date
  endsAt: Date
  limit: number
}

export interface RawCalendarEvent {
  id?: string
  calendarId?: string
  title?: string | null
  startDate: string | Date
  endDate: string | Date
  timeZone?: string | null
  allDay?: boolean
  location?: string | null
  notes?: string | null
  url?: string | null
}

export function validateCalendarListRequest(request: CalendarListRequest): ValidatedCalendarListRequest {
  const startsAt = parseDate(request.startsAt, "startsAt")
  const endsAt = parseDate(request.endsAt, "endsAt")
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new PhoneCalendarError(MiniappErrorCode.INVALID_ARGUMENT, "endsAt must be after startsAt")
  }
  if (endsAt.getTime() - startsAt.getTime() > MAX_RANGE_MS) {
    throw new PhoneCalendarError(MiniappErrorCode.INVALID_ARGUMENT, "Calendar query range may not exceed 31 days")
  }

  const limit = request.limit === undefined ? DEFAULT_LIMIT : request.limit
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new PhoneCalendarError(
      MiniappErrorCode.INVALID_ARGUMENT,
      `limit must be an integer between 1 and ${MAX_LIMIT}`,
    )
  }
  return {startsAt, endsAt, limit}
}

function parseDate(value: unknown, field: string): Date {
  if (typeof value !== "string") {
    throw new PhoneCalendarError(MiniappErrorCode.INVALID_ARGUMENT, `${field} must be an ISO 8601 string`)
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new PhoneCalendarError(MiniappErrorCode.INVALID_ARGUMENT, `${field} must be a valid ISO 8601 string`)
  }
  return date
}

export function extractHttpsLinks(...values: Array<string | null | undefined>): string[] {
  const links = new Set<string>()
  for (const value of values) {
    for (const match of value?.match(/https:\/\/[^\s<>"']+/gi) ?? []) {
      let link = match
      while (".,;:!?)]}".includes(link[link.length - 1] ?? "")) link = link.slice(0, -1)
      if (link) links.add(link)
    }
  }
  return [...links]
}

export function normalizeCalendarEvent(event: RawCalendarEvent): CalendarEvent {
  const startsAt = new Date(event.startDate).toISOString()
  const endsAt = new Date(event.endDate).toISOString()
  const calendarId = event.calendarId ?? ""
  const eventId = event.id ?? ""
  return {
    id: `${calendarId}:${eventId}:${startsAt}`,
    calendarId,
    title: event.title ?? "",
    startsAt,
    endsAt,
    ...(event.timeZone ? {timezone: event.timeZone} : {}),
    allDay: !!event.allDay,
    ...(event.location ? {location: event.location} : {}),
    ...(event.notes ? {notes: event.notes} : {}),
    ...(event.url ? {url: event.url} : {}),
    links: extractHttpsLinks(event.url, event.location, event.notes),
  }
}

export function calendarEventOverlapsWindow(event: CalendarEvent, startsAt: Date, endsAt: Date): boolean {
  return Date.parse(event.endsAt) > startsAt.getTime() && Date.parse(event.startsAt) < endsAt.getTime()
}
