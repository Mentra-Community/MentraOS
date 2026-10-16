import {getVideoSeekTime, isVideoAtEnd} from "./videoSeek"

describe("getVideoSeekTime", () => {
  it("keeps the reported video's endpoint inside the asset after native rounding", () => {
    const duration = 600.4028930664062
    const seekTime = getVideoSeekTime(duration, duration)

    expect(Math.round(Math.fround(duration) * 1000) / 1000).toBeGreaterThan(duration)
    expect(seekTime).toBeCloseTo(duration - 0.1)
    expect(Math.round(Math.fround(seekTime) * 1000) / 1000).toBeLessThan(duration)
    expect(Math.round(Math.fround(Math.fround(seekTime) * 1000)) / 1000).toBeLessThan(duration)
  })

  it.each([
    [10, 60, 10],
    [-5, 60, 0],
    [65, 60, 59.9],
    [0.05, 0.05, 0],
    [0, 60, 0],
    [10, 0, 0],
    [10, -1, 0],
    [10, NaN, 0],
    [10, Infinity, 0],
    [NaN, 60, 0],
    [Infinity, 60, 0],
  ])("bounds seek %s with duration %s to %s", (requestedTime, duration, expected) => {
    expect(getVideoSeekTime(requestedTime, duration)).toBe(expected)
  })
})

describe("isVideoAtEnd", () => {
  it.each([
    {currentTime: 60, duration: 60, expected: true},
    {currentTime: 59.999, duration: 60, expected: true},
    {currentTime: 59.967, duration: 60, expected: true},
    {currentTime: 59.9, duration: 60, expected: false},
    {currentTime: 30, duration: 60, expected: false},
    {currentTime: 0, duration: 0.05, expected: false},
    {currentTime: 0.05, duration: 0.05, expected: true},
    {currentTime: 0, duration: 0.005, expected: false},
    {currentTime: 0, duration: 0, expected: false},
    {currentTime: NaN, duration: 60, expected: false},
    {currentTime: Infinity, duration: 60, expected: false},
    {currentTime: 60, duration: Infinity, expected: false},
  ])("checks position $currentTime against duration $duration", ({currentTime, duration, expected}) => {
    expect(isVideoAtEnd(currentTime, duration)).toBe(expected)
  })
})
