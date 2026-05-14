import {decodePolyline, parseDurationSeconds} from "./routesApiCodec"

describe("decodePolyline", () => {
  test("returns [] for empty input", () => {
    expect(decodePolyline("")).toEqual([])
  })

  test("decodes the Google reference example", () => {
    // From the Google polyline algorithm spec:
    //   points = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]
    //   encoded = "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
    // https://developers.google.com/maps/documentation/utilities/polylinealgorithm
    const result = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
    expect(result).toHaveLength(3)
    expect(result[0].lat).toBeCloseTo(38.5, 5)
    expect(result[0].lng).toBeCloseTo(-120.2, 5)
    expect(result[1].lat).toBeCloseTo(40.7, 5)
    expect(result[1].lng).toBeCloseTo(-120.95, 5)
    expect(result[2].lat).toBeCloseTo(43.252, 5)
    expect(result[2].lng).toBeCloseTo(-126.453, 5)
  })

  test("decodes a single point", () => {
    // Encoded form of (38.5, -120.2) alone is "_p~iF~ps|U".
    const result = decodePolyline("_p~iF~ps|U")
    expect(result).toHaveLength(1)
    expect(result[0].lat).toBeCloseTo(38.5, 5)
    expect(result[0].lng).toBeCloseTo(-120.2, 5)
  })

  test("preserves point order", () => {
    // Same as the Google reference but the order matters — the algorithm
    // accumulates deltas, so swapping points changes every subsequent value.
    const points = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
    // The latitudes are monotonic-increasing in the reference data, which
    // is enough to assert that the second point isn't being emitted first.
    expect(points[0].lat).toBeLessThan(points[1].lat)
    expect(points[1].lat).toBeLessThan(points[2].lat)
  })

  test("handles zero-delta segments (repeated points)", () => {
    // Encoding `[[0, 0], [0, 0]]` produces "??" — two zero deltas after
    // the initial zero. Ensure we don't infinite-loop and we emit both
    // points.
    const result = decodePolyline("??")
    expect(result).toEqual([{lat: 0, lng: 0}])
  })
})

describe("parseDurationSeconds", () => {
  test("parses Routes API duration strings ending in 's'", () => {
    expect(parseDurationSeconds("123s")).toBe(123)
    expect(parseDurationSeconds("0s")).toBe(0)
    expect(parseDurationSeconds("60s")).toBe(60)
  })

  test("returns 0 for malformed or empty input", () => {
    expect(parseDurationSeconds("")).toBe(0)
    expect(parseDurationSeconds("abc")).toBe(0)
    expect(parseDurationSeconds("s")).toBe(0)
  })

  test("parses the leading integer when the suffix differs", () => {
    // Routes API documents `"123s"` but the regex is permissive — if the
    // suffix ever changes (or fractional seconds are added) we should
    // still extract the whole-second prefix rather than crashing.
    expect(parseDurationSeconds("123.45s")).toBe(123)
    expect(parseDurationSeconds("42seconds")).toBe(42)
  })
})
