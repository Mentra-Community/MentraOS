import * as RNFS from "@dr.pogodin/react-native-fs"

import {validateGalleryFiles} from "./validateGalleryFiles"

jest.mock("@dr.pogodin/react-native-fs", () => ({
  exists: jest.fn(),
  stat: jest.fn(),
}))

const mockExists = RNFS.exists as jest.MockedFunction<typeof RNFS.exists>
const mockStat = RNFS.stat as jest.MockedFunction<typeof RNFS.stat>

describe("validateGalleryFiles", () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it("bounds concurrent filesystem work for large galleries and preserves order", async () => {
    let activeChecks = 0
    let peakChecks = 0
    mockExists.mockImplementation(async () => {
      activeChecks += 1
      peakChecks = Math.max(peakChecks, activeChecks)
      await Promise.resolve()
      activeChecks -= 1
      return true
    })
    mockStat.mockResolvedValue({size: 128} as Awaited<ReturnType<typeof RNFS.stat>>)
    const entries = Array.from(
      {length: 40},
      (_, index) => [`photo-${index}`, {filePath: `/gallery/photo-${index}.jpg`}] as const,
    )

    const results = await validateGalleryFiles(entries, 4)

    expect(peakChecks).toBeLessThanOrEqual(4)
    expect(results.map((result) => result.name)).toEqual(entries.map(([name]) => name))
    expect(results.every((result) => result.status === "ok")).toBe(true)
  })

  it("drops missing and empty files but keeps entries after transient filesystem errors", async () => {
    mockExists
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("bridge unavailable"))
    mockStat.mockResolvedValueOnce({size: 0} as Awaited<ReturnType<typeof RNFS.stat>>)
    const entries: ReadonlyArray<readonly [string, {filePath: string}]> = [
      ["missing", {filePath: "/gallery/missing.jpg"}],
      ["empty", {filePath: "/gallery/empty.jpg"}],
      ["unknown", {filePath: "/gallery/unknown.jpg"}],
    ]

    await expect(validateGalleryFiles(entries, 1)).resolves.toMatchObject([
      {name: "missing", status: "stale", shouldUnlink: false},
      {name: "empty", status: "stale", shouldUnlink: true},
      {name: "unknown", status: "unknown", shouldUnlink: false},
    ])
  })
})
