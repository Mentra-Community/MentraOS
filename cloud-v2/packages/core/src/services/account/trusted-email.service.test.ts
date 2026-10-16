import {afterEach, beforeEach, expect, spyOn, test} from "bun:test"

import {UserModel} from "../../models/user.model"
import {AccountError} from "./account-error"
import * as gotrue from "./gotrue.client"
import {trustedAccountEmail} from "./trusted-email.service"

const savedSupabaseUrl = process.env.SUPABASE_URL
const mocks: Array<{mockRestore(): void}> = []

beforeEach(() => {
  process.env.SUPABASE_URL = "https://accounts.example.supabase.co"
})

afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore()
  if (savedSupabaseUrl === undefined) delete process.env.SUPABASE_URL
  else process.env.SUPABASE_URL = savedSupabaseUrl
})

function givenUser(user: {tenantId: string; tenantUserId: string; supportTelemetryDeletedAt?: Date} | null) {
  mocks.push(spyOn(UserModel, "findOne").mockReturnValue({lean: async () => user} as never))
}

function givenIdentity(identity: gotrue.GotrueIdentity | null) {
  const lookup = spyOn(gotrue, "findAccountById").mockResolvedValue(identity)
  mocks.push(lookup)
  return lookup
}

test("returns the verified email of a first-party account", async () => {
  givenUser({tenantId: "mentra", tenantUserId: "supabase-id"})
  const lookup = givenIdentity({id: "supabase-id", email: "wearer@example.com", emailVerified: true, emailConfirmed: true})

  expect(await trustedAccountEmail("mu_01TEST")).toBe("wearer@example.com")
  expect(lookup).toHaveBeenCalledWith("supabase-id", undefined, undefined)
})

test("passes the caller's signal to the account directory", async () => {
  givenUser({tenantId: "mentra", tenantUserId: "supabase-id"})
  const lookup = givenIdentity({id: "supabase-id", email: "wearer@example.com", emailVerified: true, emailConfirmed: true})
  const signal = new AbortController().signal

  await trustedAccountEmail("mu_01TEST", {signal})

  expect(lookup).toHaveBeenCalledWith("supabase-id", undefined, signal)
})

test("is null for an account the directory no longer has", async () => {
  givenUser({tenantId: "mentra", tenantUserId: "supabase-id"})
  givenIdentity(null)

  expect(await trustedAccountEmail("mu_01TEST")).toBeNull()
})

test("throws when the account directory cannot answer, so an outage is never taken for no email", async () => {
  givenUser({tenantId: "mentra", tenantUserId: "supabase-id"})
  mocks.push(
    spyOn(gotrue, "findAccountById").mockRejectedValue(
      new AccountError("server_error", "account directory unavailable", 503),
    ),
  )

  await expect(trustedAccountEmail("mu_01TEST")).rejects.toThrow("account directory unavailable")
})

test("a deleted account has no trusted email, and the directory is not asked", async () => {
  givenUser({tenantId: "mentra", tenantUserId: "supabase-id", supportTelemetryDeletedAt: new Date()})
  const lookup = givenIdentity({id: "supabase-id", email: "wearer@example.com", emailVerified: true, emailConfirmed: true})

  expect(await trustedAccountEmail("mu_01TEST")).toBeNull()
  expect(lookup).not.toHaveBeenCalled()
})

test("ignores an unverified address", async () => {
  givenUser({tenantId: "mentra", tenantUserId: "supabase-id"})
  givenIdentity({id: "supabase-id", email: "wearer@example.com", emailVerified: false, emailConfirmed: false})

  expect(await trustedAccountEmail("mu_01TEST")).toBeNull()
})

test("never resolves an OEM subject against the Mentra directory", async () => {
  givenUser({tenantId: "acme-oem", tenantUserId: "supabase-id"})
  const lookup = givenIdentity({id: "supabase-id", email: "someone@example.com", emailVerified: true, emailConfirmed: true})

  expect(await trustedAccountEmail("mu_01TEST")).toBeNull()
  expect(lookup).not.toHaveBeenCalled()
})

test("returns null without an account directory or a user row", async () => {
  const lookup = givenIdentity({id: "supabase-id", email: "wearer@example.com", emailVerified: true, emailConfirmed: true})

  givenUser(null)
  expect(await trustedAccountEmail("mu_UNKNOWN")).toBeNull()

  for (const mock of mocks.splice(0, 1)) mock.mockRestore()
  givenUser({tenantId: "mentra", tenantUserId: "supabase-id"})
  delete process.env.SUPABASE_URL
  expect(await trustedAccountEmail("mu_01TEST")).toBeNull()
  expect(lookup).not.toHaveBeenCalled()
})
