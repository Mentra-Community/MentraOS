import {describe, expect, it} from "bun:test"
import {packagedBuildInfo} from "../packagedBuildInfo"

const embedded = {appVersion: "3.2.1", buildCommit: "old", buildBranch: "old", buildUser: "old", buildTime: "old"}
describe("build identity for reused Android/iOS apps", () => {
  it("shows the current PR without changing the embedded application version", () => {
    const info = {commit: "a".repeat(40), branch: "current", user: "tester", time: "now"}
    expect(packagedBuildInfo({mentraPrBuild: {schemaVersion: 1, buildInfo: info}}, embedded)).toEqual({
      appVersion: "3.2.1",
      buildCommit: info.commit,
      buildBranch: "current",
      buildUser: "tester",
      buildTime: "now",
    })
  })
  it("preserves local/release identity and rejects partial packaged metadata", () => {
    expect(packagedBuildInfo(undefined, embedded)).toEqual(embedded)
    expect(packagedBuildInfo({mentraPrBuild: {schemaVersion: 1, buildInfo: {commit: "bad"}}}, embedded)).toEqual(
      embedded,
    )
  })
})
