import {describe, expect, test} from "bun:test"

import {selectReleaseVersionsForGarbageCollection} from "../releaseVersionGc"

describe("release version garbage collection", () => {
  test("keeps the active and rollback releases while ignoring dev artifacts", () => {
    expect(
      selectReleaseVersionsForGarbageCollection(
        ["1.0.0", "1.1.0", "2.0.0", "dev-123", ".staging-2.0.0"],
        new Set(["2.0.0", "1.1.0"]),
      ),
    ).toEqual(["1.0.0"])
  })

  test("retains a same-version reinstall and removes older semver releases", () => {
    expect(
      selectReleaseVersionsForGarbageCollection(["1.0.0", "2.0.0"], new Set(["2.0.0"])),
    ).toEqual(["1.0.0"])
  })
})
