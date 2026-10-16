import {describe, expect, test} from "bun:test"
import {describeDeletionHold, describeDeletionHolds, isWorkspaceDeletionHold} from "./deletion-holds"
import {DELETION_HOLD_REASON_PATTERN, OWNS_MINIAPPS_HOLD_REASON} from "./types"

describe("describeDeletionHold", () => {
  test("the Store's miniapps hold names how many published miniapps, and where to delete them", () => {
    const store = (count?: number) => describeDeletionHold({service: "store", reason: OWNS_MINIAPPS_HOLD_REASON, count})
    expect(store(3)).toBe("This workspace still owns 3 published miniapps. Delete them in the Developer Console first.")
    expect(store(1)).toBe("This workspace still owns 1 published miniapp. Delete it in the Developer Console first.")
    expect(store()).toBe("This workspace still owns published miniapps. Delete them in the Developer Console first.")
  })

  test("any other hold names the service and its reason in words", () => {
    expect(describeDeletionHold({service: "fleet", reason: "manages_devices", count: 4})).toBe(
      "The fleet service still needs this workspace (manages devices: 4). Resolve that before deleting it.",
    )
    expect(describeDeletionHold({service: "fleet", reason: "manages_devices"})).toBe(
      "The fleet service still needs this workspace (manages devices). Resolve that before deleting it.",
    )
    // The reason is the Store's only together with the Store.
    expect(describeDeletionHold({service: "fleet", reason: OWNS_MINIAPPS_HOLD_REASON, count: 2})).toBe(
      "The fleet service still needs this workspace (owns miniapps: 2). Resolve that before deleting it.",
    )
  })

  test("several holds read as one sentence after another", () => {
    expect(
      describeDeletionHolds([
        {service: "fleet", reason: "manages_devices"},
        {service: "store", reason: OWNS_MINIAPPS_HOLD_REASON, count: 2},
      ]),
    ).toBe(
      "The fleet service still needs this workspace (manages devices). Resolve that before deleting it. " +
        "This workspace still owns 2 published miniapps. Delete them in the Developer Console first.",
    )
  })
})

describe("isWorkspaceDeletionHold", () => {
  test("accepts the wire shape and nothing else", () => {
    expect(isWorkspaceDeletionHold({service: "store", reason: "owns_miniapps", count: 3})).toBe(true)
    expect(isWorkspaceDeletionHold({service: "store", reason: "owns_miniapps"})).toBe(true)
    for (const value of [
      null,
      "store",
      [],
      {reason: "owns_miniapps"},
      {service: "", reason: "owns_miniapps"},
      {service: "store"},
      {service: "store", reason: ""},
      {service: "store", reason: "owns_miniapps", count: 0},
      {service: "store", reason: "owns_miniapps", count: 1.5},
      {service: "store", reason: "owns_miniapps", count: "3"},
      {service: "store", reason: "owns_miniapps", count: null},
    ]) {
      expect({value, ok: isWorkspaceDeletionHold(value)}).toEqual({value, ok: false})
    }
  })
})

describe("DELETION_HOLD_REASON_PATTERN", () => {
  test("is a lowercase code of at most 64 characters starting with a letter", () => {
    for (const ok of ["owns_miniapps", "a", "x".repeat(64), "v2_devices"]) expect(DELETION_HOLD_REASON_PATTERN.test(ok)).toBe(true)
    for (const bad of ["", "Owns", "owns miniapps", "_x", "1x", "owns-miniapps", "x".repeat(65), "owns_miniapps\n"]) {
      expect({bad, ok: DELETION_HOLD_REASON_PATTERN.test(bad)}).toEqual({bad, ok: false})
    }
  })
})
