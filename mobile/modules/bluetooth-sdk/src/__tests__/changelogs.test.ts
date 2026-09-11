import {getReleaseChangelogs} from "../changelogs"

describe("getReleaseChangelogs", () => {
  it("includes the target changelog for a transition within one release train", () => {
    expect(getReleaseChangelogs("3.1.0-dev.2", "3.1.0-beta.8")).toEqual([expect.objectContaining({version: "3.1.0"})])
  })

  it("returns the target changelog when the starting version is unavailable", () => {
    expect(getReleaseChangelogs(null, "3.1.0").map(({version}) => version)).toEqual(["3.1.0"])
  })

  it("rejects malformed and unauthored target versions", () => {
    expect(() => getReleaseChangelogs("old", "3.1.0")).toThrow(/fromVersion must be a semantic version/)
    expect(() => getReleaseChangelogs("3.1.0", "3.2.0")).toThrow(/No changelog is bundled/)
  })
})
