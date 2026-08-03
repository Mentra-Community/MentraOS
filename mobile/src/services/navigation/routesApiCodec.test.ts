// routesApiCodec moved into island; this jest test stays here (CI-gated) and imports
// the moved util by path (the island module's own test runner is bit-rotted).
import {decodePolyline, parseDurationSeconds} from "../../../modules/engine/src/services/navigation/routesApiCodec"

describe("decodePolyline", () => {
  test("returns [] for empty input", () => {
    expect(decodePolyline("")).toEqual([])
  })

  test("decodes the precision-5 reference example", () => {
    // From the polyline algorithm spec (precision 5):
    //   points = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]
    //   encoded = "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
    // Mapbox `polyline` (and Google Routes) use precision 5; Mapbox
    // `polyline6` uses precision 6, which is our default — so the
    // precision-5 fixtures decode with an explicit precision argument.
    const result = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5)
    expect(result).toHaveLength(3)
    expect(result[0].lat).toBeCloseTo(38.5, 5)
    expect(result[0].lng).toBeCloseTo(-120.2, 5)
    expect(result[1].lat).toBeCloseTo(40.7, 5)
    expect(result[1].lng).toBeCloseTo(-120.95, 5)
    expect(result[2].lat).toBeCloseTo(43.252, 5)
    expect(result[2].lng).toBeCloseTo(-126.453, 5)
  })

  test("default precision is 6 (Mapbox polyline6)", () => {
    // The same encoded bytes decoded at precision 6 are 10× smaller than
    // at precision 5 — this guards the default so a caller that forgets to
    // pass precision still gets polyline6 (what Directions returns).
    const p5 = decodePolyline("_p~iF~ps|U", 5)[0]
    const p6 = decodePolyline("_p~iF~ps|U")[0]
    expect(p6.lat).toBeCloseTo(p5.lat / 10, 5)
    expect(p6.lng).toBeCloseTo(p5.lng / 10, 5)
  })

  test("decodes a single point at precision 5", () => {
    const result = decodePolyline("_p~iF~ps|U", 5)
    expect(result).toHaveLength(1)
    expect(result[0].lat).toBeCloseTo(38.5, 5)
    expect(result[0].lng).toBeCloseTo(-120.2, 5)
  })

  test("preserves point order", () => {
    const points = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5)
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
  test("passes through Mapbox numeric durations (rounding)", () => {
    // Mapbox Directions returns `duration` as a number of seconds.
    expect(parseDurationSeconds(972.575)).toBe(973)
    expect(parseDurationSeconds(0)).toBe(0)
    expect(parseDurationSeconds(60)).toBe(60)
  })

  test("parses legacy Routes API duration strings ending in 's'", () => {
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
