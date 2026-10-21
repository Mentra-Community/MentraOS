import {afterEach, describe, expect, spyOn, test} from "bun:test"

import {SigninIdentityModel} from "../../models/signin-identity.model"
import {memberNames} from "./member-names.service"

type IdentityRow = {mentraUserId: string; name?: string | null}

/** Answer `SigninIdentityModel.find` with `rows` and record each call's filter and projection. */
function identities(rows: IdentityRow[]) {
  return spyOn(SigninIdentityModel, "find").mockImplementation(((filter: unknown, projection: unknown) => {
    void filter
    void projection
    return {lean: async () => rows}
  }) as never)
}

let find: ReturnType<typeof identities> | undefined

afterEach(() => {
  find?.mockRestore()
  find = undefined
})

describe("memberNames", () => {
  test("names the people whose sign-in carries a name, and leaves out everyone else", async () => {
    find = identities([
      {mentraUserId: "mu_ada", name: "Ada Lovelace"},
      {mentraUserId: "mu_grace", name: null},
      {mentraUserId: "mu_blank", name: "   "},
      {mentraUserId: "mu_empty", name: ""},
      {mentraUserId: "mu_missing"},
    ])

    const names = await memberNames(["mu_ada", "mu_grace", "mu_blank", "mu_empty", "mu_missing", "mu_never_signed_in"])

    expect(names).toEqual(new Map([["mu_ada", "Ada Lovelace"]]))
  })

  test("reads signin_identities once for the whole list, however long, each person once", async () => {
    const ids = Array.from({length: 50}, (_, index) => `mu_${index}`)
    find = identities(ids.map((mentraUserId) => ({mentraUserId, name: `Person ${mentraUserId}`})))

    // A repeated id, a member still waiting for their first sign-in (no id) and an undefined entry are not extra reads.
    const names = await memberNames([...ids, "mu_3", null, undefined])

    expect(find).toHaveBeenCalledTimes(1)
    const [filter, projection] = find.mock.calls[0] as unknown as [
      {mentraUserId: {$in: string[]}},
      Record<string, number>,
    ]
    expect(filter.mentraUserId.$in).toEqual(ids)
    // Only what is needed: the id and the name, never the email or the sign-in source.
    expect(projection).toEqual({mentraUserId: 1, name: 1})
    expect(names.size).toBe(50)
    expect(names.get("mu_49")).toBe("Person mu_49")
  })

  test("reads nothing when there is nobody to name", async () => {
    find = identities([])

    expect(await memberNames([])).toEqual(new Map())
    expect(await memberNames([null, undefined, ""])).toEqual(new Map())
    expect(find).not.toHaveBeenCalled()
  })
})
