/**
 * @fileoverview A person's declared age, kept on their Core account: `/api/account/declared-age`.
 *
 * A miniapp that declares an `ageRating` above the host app's own App Store rating installs or opens only for a person
 * whose declared age is old enough (App Store Review Guideline 4.7.5). The first time that comes up, the app asks the
 * person's age once, and Core keeps it on their account with the date they gave it. Their age now is the declared age
 * plus the whole years since that date ({@link currentDeclaredAge}). Core never puts it in a token or sends it to a
 * miniapp.
 *
 *   GET /api/account/declared-age           {declaredAge, declaredAgeAt}, both null until the person answers
 *   PUT /api/account/declared-age   {age}   {declaredAge, declaredAgeAt}
 *
 * `GET /api/account/me` carries the same two fields.
 */
import {z} from "zod"

/** The ages a person may give: a whole number of years. */
export const DECLARED_AGE_MIN = 1
export const DECLARED_AGE_MAX = 120

export const DeclaredAgeRequestSchema = z.object({
  age: z.number().int().min(DECLARED_AGE_MIN).max(DECLARED_AGE_MAX),
})
export type DeclaredAgeRequest = z.infer<typeof DeclaredAgeRequestSchema>

/** What Core keeps. Both fields are null until the person answers, and set together after. */
export interface DeclaredAge {
  /** The age the person gave. */
  declaredAge: number | null
  /** When they gave it, ISO 8601. */
  declaredAgeAt: string | null
}

export const DeclaredAgeSchema: z.ZodType<DeclaredAge> = z.union([
  z.object({
    declaredAge: z.number().int().min(DECLARED_AGE_MIN).max(DECLARED_AGE_MAX),
    declaredAgeAt: z.string().datetime({offset: true}),
  }),
  z.object({declaredAge: z.null(), declaredAgeAt: z.null()}),
])

/**
 * The person's age at `now`: the age they gave plus the whole years since they gave it, counted by calendar date in
 * UTC. Never less than the age they gave, even when `now` is earlier.
 */
export function currentDeclaredAge(declaredAge: number, declaredAgeAt: string | Date, now: Date): number {
  const at = new Date(declaredAgeAt)
  if (Number.isNaN(at.getTime()) || Number.isNaN(now.getTime())) return declaredAge
  let years = now.getUTCFullYear() - at.getUTCFullYear()
  const beforeAnniversary =
    now.getUTCMonth() < at.getUTCMonth() ||
    (now.getUTCMonth() === at.getUTCMonth() && now.getUTCDate() < at.getUTCDate())
  if (beforeAnniversary) years -= 1
  return declaredAge + Math.max(0, years)
}
