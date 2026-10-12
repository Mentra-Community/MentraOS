import {afterEach, beforeEach, expect, spyOn, test} from "bun:test"

import {UserModel} from "../../models/user.model"
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

function givenUser(user: {tenantId: string; tenantUserId: string} | null) {
  mocks.push(spyOn(UserModel, "findOne").mockReturnValue({lean: async () => user} as never))
}

function givenIdentity(identity: gotrue.GotrueIdentity | null) {
  const lookup = spyOn(gotrue, "getUserById").mockResolvedValue(identity)
  mocks.push(lookup)
  return lookup
}

test("returns the verified email of a first-party account", async () => {
  givenUser({tenantId: "mentra", tenantUserId: "supabase-id"})
  const lookup = givenIdentity({id: "supabase-id", email: "wearer@example.com", emailVerified: true, emailConfirmed: true})

  expect(await trustedAccountEmail("mu_01TEST")).toBe("wearer@example.com")
  expect(lookup).toHaveBeenCalledWith("supabase-id", undefined)
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
