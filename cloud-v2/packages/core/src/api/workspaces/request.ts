/**
 * @fileoverview Request parsing shared by the workspace and organization routes.
 *
 * Core's API has no schema library, so bodies are checked by hand: each helper
 * either returns a value of the right type or throws `InvalidRequest` (400
 * `{error: "invalid_request", error_description}`). Anything finer than the type
 * (name length, role rules, package name shape) belongs to the services, which
 * answer with their own codes.
 */

import type {AppContext} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"

export type JsonObject = Record<string, unknown>

/** The default and the largest page a list endpoint serves. */
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

/** `text` as a JSON object. Empty, malformed, array and scalar bodies are a 400. */
export function parseJsonObject(text: string): JsonObject {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new InvalidRequest("request body must be a JSON object")
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidRequest("request body must be a JSON object")
  }
  return body as JsonObject
}

/** The request body as a JSON object. A missing, malformed, array or scalar body is a 400. */
export async function readJsonObject(c: AppContext): Promise<JsonObject> {
  let text: string
  try {
    text = await c.req.text()
  } catch {
    throw new InvalidRequest("request body must be a JSON object")
  }
  return parseJsonObject(text)
}

/** A non-empty string field. */
export function requiredString(body: JsonObject, field: string): string {
  const value = body[field]
  if (typeof value !== "string" || value.length === 0) throw new InvalidRequest(`${field} must be a non-empty string`)
  return value
}

/** The workspace revision the caller last saw: a whole number, zero or more. */
export function expectedRevision(body: JsonObject): number {
  const value = body.expectedRevision
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidRequest("expectedRevision must be a non-negative integer")
  }
  return value
}

/** An array of strings, or undefined when the field is absent. */
export function optionalStringArray(body: JsonObject, field: string): string[] | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  return stringArray(value, field)
}

/** An array of strings. */
export function requiredStringArray(body: JsonObject, field: string): string[] {
  return stringArray(body[field], field)
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new InvalidRequest(`${field} must be an array of strings`)
  }
  return value as string[]
}

/** An ISO 8601 date-time: `YYYY-MM-DDTHH:MM` with optional seconds, fraction and `Z` or `±hh:mm` offset. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * An ISO 8601 date-time string as a Date, or null when the field is absent or null. Free-form dates
 * ("12345", "March 1 2030") are refused rather than guessed at by the JavaScript parser. Whether the
 * date is in the future is for the service.
 */
export function optionalDate(body: JsonObject, field: string): Date | null {
  const value = body[field]
  if (value === undefined || value === null) return null
  const date = typeof value === "string" && ISO_DATE_TIME.test(value) ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) throw new InvalidRequest(`${field} must be an ISO 8601 date-time string`)
  return date
}

/** The `limit` query parameter: a positive integer, defaulting to 50 and capped at 200. */
export function pageLimit(c: AppContext): number {
  const raw = c.req.query("limit")
  if (raw === undefined) return DEFAULT_PAGE_SIZE
  if (!/^[1-9]\d*$/.test(raw)) throw new InvalidRequest("limit must be a positive integer")
  return Math.min(Number(raw), MAX_PAGE_SIZE)
}
