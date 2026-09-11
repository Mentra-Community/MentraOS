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

interface CalendarDateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function localDateParts(date: Date): CalendarDateParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  }
}

function datePartsInTimeZone(date: Date, timeZone: string): CalendarDateParts | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date)
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
    return {
      year: value("year"),
      month: value("month"),
      day: value("day"),
      hour: value("hour"),
      minute: value("minute"),
      second: value("second"),
    }
  } catch {
    return undefined
  }
}

function timeZoneOffsetMinutes(date: Date, timeZone: string): number | undefined {
  const parts = datePartsInTimeZone(date, timeZone)
  if (!parts) return undefined
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    date.getUTCMilliseconds(),
  )
  return Math.round((representedAsUtc - date.getTime()) / 60_000)
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0")
}

function formatOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "Z"
  const sign = offsetMinutes < 0 ? "-" : "+"
  const absolute = Math.abs(offsetMinutes)
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

function formatAllDayDate(value: string | Date, timeZone?: string | null): string {
  const dateOnly = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
  if (dateOnly) {
    const [, year, month, day] = dateOnly
    const localMidnight = new Date(Number(year), Number(month) - 1, Number(day))
    let offsetMinutes = -localMidnight.getTimezoneOffset()
    if (timeZone) {
      // Resolve the offset at midnight in the event timezone. Repeating once
      // accounts for the initial UTC guess landing across a DST boundary.
      const wallTime = Date.UTC(Number(year), Number(month) - 1, Number(day))
      let instant = new Date(wallTime)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const offset = timeZoneOffsetMinutes(instant, timeZone)
        if (offset === undefined) break
        offsetMinutes = offset
        instant = new Date(wallTime - offset * 60_000)
      }
    }
    return `${year}-${month}-${day}T00:00:00.000${formatOffset(offsetMinutes)}`
  }

  const date = new Date(value)
  const zonedParts = timeZone ? datePartsInTimeZone(date, timeZone) : undefined
  const parts = zonedParts ?? localDateParts(date)
  const offsetMinutes =
    timeZone && zonedParts
      ? (timeZoneOffsetMinutes(date, timeZone) ?? -date.getTimezoneOffset())
      : -date.getTimezoneOffset()
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${pad(date.getUTCMilliseconds(), 3)}${formatOffset(offsetMinutes)}`
}

export function normalizeCalendarEvent(event: RawCalendarEvent): CalendarEvent {
  const startsAt = event.allDay
    ? formatAllDayDate(event.startDate, event.timeZone)
    : new Date(event.startDate).toISOString()
  const endsAt = event.allDay ? formatAllDayDate(event.endDate, event.timeZone) : new Date(event.endDate).toISOString()
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
