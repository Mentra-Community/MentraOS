import {describe, expect, it} from "bun:test"
import {packagedBuildInfo} from "../packagedBuildInfo"

const local = {appVersion: "3.2.1", buildCommit: "old", buildBranch: "old", buildUser: "old", buildTime: "old"}
describe("the app's identity", () => {
  it("comes from the packaged build config of a CI build", () => {
    const info = {commit: "a".repeat(40), branch: "current", user: "tester", time: "now"}
    expect(
      packagedBuildInfo({mentraBuild: {schemaVersion: 2, identity: "3.5.0-beta.1351", buildInfo: info}}, local),
    ).toEqual({
      appVersion: "3.5.0-beta.1351",
      buildCommit: info.commit,
      buildBranch: "current",
      buildUser: "tester",
      buildTime: "now",
    })
  })
  it("keeps the packaged identity when the build info is not packaged yet", () => {
    expect(packagedBuildInfo({mentraBuild: {schemaVersion: 2, identity: "3.5.0", buildInfo: ""}}, local)).toEqual({
      ...local,
      appVersion: "3.5.0",
    })
  })
  it("is a local build's own without a packaged config, and ignores partial build info", () => {
    expect(packagedBuildInfo(undefined, local)).toEqual(local)
    expect(packagedBuildInfo({mentraBuild: {schemaVersion: 2, buildInfo: {commit: "bad"}}}, local)).toEqual(local)
  })
})
