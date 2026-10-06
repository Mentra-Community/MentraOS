import {setPackagesBlocked} from "./notificationBlocklist"

describe("setPackagesBlocked", () => {
  it("blocks every listed package and keeps existing entries", () => {
    expect(setPackagesBlocked(["com.old"], ["com.a", "com.b"], true)).toEqual(["com.old", "com.a", "com.b"])
  })

  it("does not duplicate packages that were already blocked", () => {
    expect(setPackagesBlocked(["com.a", "com.a"], ["com.a", "com.b"], true)).toEqual(["com.a", "com.b"])
  })

  it("unblocks only the listed packages", () => {
    expect(setPackagesBlocked(["com.a", "com.hidden", "com.b"], ["com.a", "com.b"], false)).toEqual(["com.hidden"])
  })

  it("leaves the blocklist unchanged for an empty selection", () => {
    expect(setPackagesBlocked(["com.a"], [], true)).toEqual(["com.a"])
    expect(setPackagesBlocked(["com.a"], [], false)).toEqual(["com.a"])
  })
})
