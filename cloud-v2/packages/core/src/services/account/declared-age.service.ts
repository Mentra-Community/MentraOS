/**
 * @fileoverview The age a person declared, kept on their Core user (`users.declaredAge`, `users.declaredAgeAt`).
 *
 * An app asks once, when a miniapp rated above its own App Store rating first installs or opens, and keeps the
 * answer here with the date it was given; the person's age now is the declared age plus the whole years since
 * (`currentDeclaredAge` in `@mentra/cloud-protocol`). Core only stores it: it is never put in a token or sent to a
 * miniapp, and account deletion clears it.
 */
import type {DeclaredAge} from "@mentra/cloud-protocol"
import {UserModel} from "../../models/user.model"
import {InvalidRequest} from "../../types/oauth.types"

const NONE: DeclaredAge = {declaredAge: null, declaredAgeAt: null}

/** The person's declared age, or both fields null when they haven't given one. */
export async function readDeclaredAge(mentraUserId: string): Promise<DeclaredAge> {
  const user = await UserModel.findOne({mentraUserId}).select({declaredAge: 1, declaredAgeAt: 1}).lean()
  if (!user) throw new InvalidRequest("user not found")
  return toView(user.declaredAge, user.declaredAgeAt)
}

/** Keep `age`, given now, as the person's declared age. A later answer replaces an earlier one. */
export async function setDeclaredAge(mentraUserId: string, age: number, now = new Date()): Promise<DeclaredAge> {
  const updated = await UserModel.findOneAndUpdate(
    {mentraUserId, supportTelemetryDeletedAt: null},
    {$set: {declaredAge: age, declaredAgeAt: now}},
    {new: true, projection: {declaredAge: 1, declaredAgeAt: 1}},
  ).lean()
  if (!updated) throw new InvalidRequest("user not found")
  return toView(updated.declaredAge, updated.declaredAgeAt)
}

function toView(age: number | null | undefined, at: Date | null | undefined): DeclaredAge {
  if (typeof age !== "number" || !(at instanceof Date)) return NONE
  return {declaredAge: age, declaredAgeAt: at.toISOString()}
}
