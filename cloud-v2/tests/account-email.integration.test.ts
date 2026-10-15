/**
 * @fileoverview Core's copy of each account's verified email (`account_emails`, `account-email.service.ts`).
 *
 * The account directory (GoTrue's admin API) is a fake identity provider (`support/fake-idp.ts`) that records every
 * user lookup it answers; the copy is real rows on a local replica set.
 *
 * What it pins: an account costs the directory one lookup a day however often it is asked about, from any Core
 * process (the copy is in the database, so a restarted or second process asks nothing); a copy a day old is checked
 * again, so a change made in the directory itself is picked up; an account without a verified email is kept as
 * null; a directory that cannot answer leaves Core's copy in place and never stores "no email"; an email changed
 * through Core is read from the directory on the next lookup, however concurrent changes were ordered, and a lookup
 * that started before the change cannot overwrite it.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores `MONGO_URL`)
 * and asserts the live connection is on that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/account-email.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"

import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccountCodeModel} from "../packages/core/src/models/account-code.model"
import {AccountEmailModel} from "../packages/core/src/models/account-email.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {
  ACCOUNT_EMAIL_MAX_AGE_MS,
  accountEmail,
  markAccountEmailChanged,
} from "../packages/core/src/services/account/account-email.service"
import {confirmEmailChange, gotrue, otc} from "../packages/core/src/services/account/account.service"
import * as trustedEmail from "../packages/core/src/services/account/trusted-email.service"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {applyEnv, HOSTED_ENV, SUPABASE_ISSUER, SUPABASE_JWKS, SUPABASE_PROJECT, SUPABASE_SECRET} from "./support/signin-harness"

setDefaultTimeout(30_000)

const MODELS = [AccountCodeModel, AccountEmailModel, UserModel] as const

let databaseUrl: string
let verified = false
let idp: FakeIdp
let restoreEnv: () => void = () => {}

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("account-email")
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
})

afterAll(async () => {
  if (verified && UserModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  restoreEnv = applyEnv({...HOSTED_ENV})
  assertConnectedTo(databaseUrl, UserModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  idp = await installFakeIdp({
    issuer: SUPABASE_ISSUER,
    jwksUrl: SUPABASE_JWKS,
    hs256Secret: SUPABASE_SECRET,
    projectUrl: SUPABASE_PROJECT,
  })
})

afterEach(() => {
  idp.restore()
  restoreEnv()
})

/** A Mentra account in the directory, and its Core user. */
async function account(key: string, options: {emailConfirmed?: boolean} = {}) {
  const sub = `supa-${key}`
  const email = `${key}@example.test`
  idp.registerUser({sub, email, emailConfirmed: options.emailConfirmed ?? true})
  const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: sub})
  return {sub, email, mentraUserId}
}

/** Makes Core's copy of the account's email look `ageMs` old. */
async function age(mentraUserId: string, ageMs: number) {
  await AccountEmailModel.updateOne({mentraUserId}, {$set: {checkedAt: new Date(Date.now() - ageMs)}})
}

describe("an account's email", () => {
  test("is asked of the account directory once, then read from Core's copy", async () => {
    const a = await account("once")

    for (let i = 0; i < 10; i++) expect(await accountEmail(a.mentraUserId)).toBe(a.email)

    expect(idp.userLookups).toEqual([a.sub])
    expect(await AccountEmailModel.findOne({mentraUserId: a.mentraUserId}).lean()).toMatchObject({
      email: a.email,
      checkedAt: expect.any(Date),
    })
  })

  test("is checked with the directory again once Core's copy is a day old, so a change made there is picked up", async () => {
    const a = await account("daily")
    await accountEmail(a.mentraUserId)

    await age(a.mentraUserId, ACCOUNT_EMAIL_MAX_AGE_MS - 60_000)
    expect(await accountEmail(a.mentraUserId)).toBe(a.email)
    expect(idp.userLookups).toHaveLength(1)

    idp.registerUser({sub: a.sub, email: "renamed@example.test", emailConfirmed: true})
    await age(a.mentraUserId, ACCOUNT_EMAIL_MAX_AGE_MS)
    expect(await accountEmail(a.mentraUserId)).toBe("renamed@example.test")
    expect(idp.userLookups).toHaveLength(2)

    // The new answer is good for another day.
    expect(await accountEmail(a.mentraUserId)).toBe("renamed@example.test")
    expect(idp.userLookups).toHaveLength(2)
  })

  test("an account without a verified email is kept as null, and costs the directory no more lookups", async () => {
    const a = await account("unverified", {emailConfirmed: false})

    expect(await accountEmail(a.mentraUserId)).toBeNull()
    expect(await accountEmail(a.mentraUserId)).toBeNull()

    expect(idp.userLookups).toEqual([a.sub])
  })

  test("a directory that cannot answer leaves Core's copy in place, and is asked again next time", async () => {
    const a = await account("outage")
    await accountEmail(a.mentraUserId)
    await age(a.mentraUserId, ACCOUNT_EMAIL_MAX_AGE_MS)
    const before = (await AccountEmailModel.findOne({mentraUserId: a.mentraUserId}).lean())!

    idp.outage = true
    expect(await accountEmail(a.mentraUserId)).toBe(a.email)
    // Nothing was learned, so the copy is still due for a check.
    expect(await AccountEmailModel.findOne({mentraUserId: a.mentraUserId}).lean()).toEqual(before)

    idp.outage = false
    idp.userLookups.length = 0
    expect(await accountEmail(a.mentraUserId)).toBe(a.email)
    expect(idp.userLookups).toEqual([a.sub])
  })

  test("a directory that cannot answer, with no copy yet, fails the lookup and stores nothing", async () => {
    const a = await account("outage-first")
    idp.outage = true

    await expect(accountEmail(a.mentraUserId)).rejects.toThrow()

    expect(await AccountEmailModel.countDocuments({mentraUserId: a.mentraUserId})).toBe(0)
  })

  test("an email changed through Core is read from the directory on the next lookup, once", async () => {
    const a = await account("changed")
    await accountEmail(a.mentraUserId)

    idp.registerUser({sub: a.sub, email: "changed@example.test", emailConfirmed: true})
    await markAccountEmailChanged(a.mentraUserId)

    expect(await accountEmail(a.mentraUserId)).toBe("changed@example.test")
    expect(await accountEmail(a.mentraUserId)).toBe("changed@example.test")
    expect(idp.userLookups).toEqual([a.sub, a.sub])
  })

  test("a lookup that started before an email change does not keep the address it read", async () => {
    const a = await account("race")
    let answer: ((email: string | null) => void) | undefined
    const lookup = spyOn(trustedEmail, "trustedAccountEmail").mockImplementation(
      () => new Promise<string | null>(resolve => (answer = resolve)),
    )
    try {
      const inFlight = accountEmail(a.mentraUserId)
      while (!answer) await Bun.sleep(1)

      idp.registerUser({sub: a.sub, email: "changed@example.test", emailConfirmed: true})
      await markAccountEmailChanged(a.mentraUserId)
      // The directory answers with the address it had when the lookup asked, before the change.
      answer(a.email)
      await inFlight
    } finally {
      lookup.mockRestore()
    }

    expect(await accountEmail(a.mentraUserId)).toBe("changed@example.test")
  })

  test("two email changes confirmed at once leave the address the directory ended with", async () => {
    const a = await account("twice")
    await accountEmail(a.mentraUserId)
    const codeFor = (newEmail: string) =>
      otc.issueEmailCode({purpose: "email_change", subject: a.sub, ttlSec: 60, payload: {newEmail}})
    const [first, second] = [await codeFor("first@example.test"), await codeFor("second@example.test")]

    // The directory applies "first" and then "second", but Core finishes the second confirmation before the first.
    const applied: string[] = []
    const release = new Map<string, () => void>()
    const setEmail = spyOn(gotrue, "setEmail").mockImplementation(async (userId, email) => {
      idp.registerUser({sub: userId, email, emailConfirmed: true})
      applied.push(email)
      await new Promise<void>(resolve => release.set(email, resolve))
    })
    try {
      const confirmingFirst = confirmEmailChange(a.mentraUserId, a.sub, first)
      while (applied.length < 1) await Bun.sleep(1)
      const confirmingSecond = confirmEmailChange(a.mentraUserId, a.sub, second)
      while (applied.length < 2) await Bun.sleep(1)

      release.get("second@example.test")!()
      await confirmingSecond
      release.get("first@example.test")!()
      await confirmingFirst
    } finally {
      setEmail.mockRestore()
    }

    expect(applied).toEqual(["first@example.test", "second@example.test"])
    expect(await accountEmail(a.mentraUserId)).toBe("second@example.test")
  })

  test("a deleted account's email is not kept", async () => {
    const a = await account("deleted")
    await UserModel.updateOne({mentraUserId: a.mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})

    expect(await accountEmail(a.mentraUserId)).toBeNull()

    expect(idp.userLookups).toEqual([])
    expect((await AccountEmailModel.findOne({mentraUserId: a.mentraUserId}).lean())?.email ?? null).toBeNull()
  })
})
