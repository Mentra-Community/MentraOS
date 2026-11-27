import {describe, expect, test} from "bun:test"
import * as publisher from "../../../.github/scripts/publish-miniapp-r2"
import {compareVersions, isSemver, listedVersions, MAX_VERSIONS, mergeVersions, type VersionEntry} from "./versions"

const entry = (version: string, tag = "a"): VersionEntry => ({
  version,
  url: `com.example.notes-${version}-${tag.repeat(8)}.zip`,
  sha256: tag.repeat(64),
})

/** Lowest first, by SemVer 2.0.0 precedence (semver.org, item 11). */
const ASCENDING = [
  "0.0.1",
  "0.9.9",
  "1.0.0-0",
  "1.0.0-2",
  "1.0.0-11",
  "1.0.0-alpha",
  "1.0.0-alpha.1",
  "1.0.0-alpha.beta",
  "1.0.0-beta",
  "1.0.0-beta.2",
  "1.0.0-beta.11",
  "1.0.0-rc.1",
  "1.0.0",
  "1.0.0+build.1",
  "1.0.0+build.2",
  "1.0.1",
  "1.2.0",
  "1.10.0",
  "2.0.0",
  "10.0.0",
  "99999999999999999999.0.0",
  "100000000000000000000.0.0",
]

describe("compareVersions", () => {
  test("orders by SemVer precedence: numbers as numbers, a prerelease below its release", () => {
    for (let low = 0; low < ASCENDING.length; low++) {
      for (let high = low + 1; high < ASCENDING.length; high++) {
        expect(compareVersions(ASCENDING[low]!, ASCENDING[high]!)).toBeLessThan(0)
        expect(compareVersions(ASCENDING[high]!, ASCENDING[low]!)).toBeGreaterThan(0)
      }
      expect(compareVersions(ASCENDING[low]!, ASCENDING[low]!)).toBe(0)
    }
  })

  test("knows a semantic version from other text", () => {
    for (const version of ASCENDING) expect(isSemver(version)).toBe(true)
    for (const version of ["1.0", "v1.0.0", "01.0.0", "1.0.0-", "1.0.0-01", "2024.1", "", "latest"]) {
      expect(isSemver(version)).toBe(false)
    }
  })
})

describe("mergeVersions", () => {
  test("puts the entry in, highest version first", () => {
    expect(mergeVersions([entry("1.2.0"), entry("1.0.0")], entry("1.1.0"))).toEqual([
      entry("1.2.0"),
      entry("1.1.0"),
      entry("1.0.0"),
    ])
    expect(mergeVersions([], entry("1.0.0"))).toEqual([entry("1.0.0")])
  })

  test("replaces the entry of the same version, and sorts a list that wasn't", () => {
    expect(mergeVersions([entry("1.0.0"), entry("1.2.0"), entry("1.1.0", "a")], entry("1.1.0", "b"))).toEqual([
      entry("1.2.0"),
      entry("1.1.0", "b"),
      entry("1.0.0"),
    ])
  })

  test("keeps one entry per version: the first of two", () => {
    expect(mergeVersions([entry("1.0.0", "a"), entry("1.0.0", "b")], entry("2.0.0"))).toEqual([
      entry("2.0.0"),
      entry("1.0.0", "a"),
    ])
  })

  test(`keeps the ${MAX_VERSIONS} highest, and always the entry`, () => {
    const many = Array.from({length: 70}, (_, index) => entry(`1.${index}.0`))
    const withHigher = mergeVersions(many, entry("3.0.0"))
    expect(withHigher).toHaveLength(MAX_VERSIONS)
    expect(withHigher[0]!.version).toBe("3.0.0")
    expect(withHigher.at(-1)!.version).toBe("1.21.0")

    const withLower = mergeVersions(many, entry("0.1.0"))
    expect(withLower).toHaveLength(MAX_VERSIONS)
    expect(withLower[0]!.version).toBe("1.69.0")
    expect(withLower.at(-2)!.version).toBe("1.21.0")
    expect(withLower.at(-1)!.version).toBe("0.1.0")
  })
})

describe("listedVersions", () => {
  test("reads a list, with its hashes in lowercase and nothing but version, url and sha256", () => {
    expect(
      listedVersions({versions: [{version: "1.0.0", url: "a.zip", sha256: "AB".repeat(32), note: "kept out"}]}),
    ).toEqual([{version: "1.0.0", url: "a.zip", sha256: "ab".repeat(32)}])
    expect(listedVersions({versions: []})).toEqual([])
  })

  test("a miniapp.json with no list offers the build it serves", () => {
    expect(listedVersions({version: "1.0.0", bundle: {url: "a.zip", sha256: "0".repeat(64)}})).toEqual([
      {version: "1.0.0", url: "a.zip", sha256: "0".repeat(64)},
    ])
    expect(listedVersions({version: "1.0.0"})).toEqual([])
    expect(listedVersions({version: "not a version", bundle: {url: "a.zip", sha256: "0".repeat(64)}})).toEqual([])
  })

  test.each([
    ["not a list", {versions: {"1.0.0": "a.zip"}}],
    ["an entry that isn't an object", {versions: ["1.0.0"]}],
    ["an entry without a url", {versions: [{version: "1.0.0", sha256: "0".repeat(64)}]}],
    ["an entry with a blank url", {versions: [{version: "1.0.0", url: " ", sha256: "0".repeat(64)}]}],
    ["an entry whose hash isn't a SHA-256", {versions: [{version: "1.0.0", url: "a.zip", sha256: "abc"}]}],
    ["an entry whose version isn't SemVer", {versions: [{version: "1.0", url: "a.zip", sha256: "0".repeat(64)}]}],
  ])("throws for %s", (_name, served) => {
    expect(() => listedVersions(served)).toThrow("versions")
  })
})

describe("the first-party publisher's copy of these rules", () => {
  test("orders every pair of versions the same way", () => {
    for (const a of ASCENDING) {
      for (const b of ASCENDING) {
        expect(Math.sign(publisher.compareVersions(a, b))).toBe(Math.sign(compareVersions(a, b)))
      }
    }
  })

  test("merges the same lists to the same lists", () => {
    const lists = [
      [],
      [entry("1.0.0")],
      [entry("1.0.0", "a"), entry("1.0.0", "b"), entry("0.5.0")],
      ASCENDING.map((version) => entry(version)),
      Array.from({length: 70}, (_, index) => entry(`1.${(index * 37) % 70}.0`)),
    ]
    for (const list of lists) {
      for (const added of [entry("1.0.0", "c"), entry("0.0.1-rc.1"), entry("500.0.0")]) {
        expect(publisher.mergeVersions(list, added)).toEqual(mergeVersions(list, added))
      }
    }
  })

  test("reads the same served miniapp.json to the same list, and refuses the same ones", () => {
    const readable = [
      {versions: [{version: "1.0.0", url: "a.zip", sha256: "AB".repeat(32)}]},
      {versions: []},
      {version: "1.0.0", bundle: {url: "a.zip", sha256: "0".repeat(64)}},
      {version: "1.0.0"},
    ]
    for (const served of readable) expect(publisher.listedVersions(served)).toEqual(listedVersions(served))
    const unreadable = [{versions: {}}, {versions: [{version: "1.0", url: "a.zip", sha256: "0".repeat(64)}]}]
    for (const served of unreadable) {
      expect(() => listedVersions(served)).toThrow()
      expect(() => publisher.listedVersions(served)).toThrow()
    }
  })
})
