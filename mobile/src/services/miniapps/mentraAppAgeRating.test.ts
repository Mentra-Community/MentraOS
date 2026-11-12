import {mentraAppAgeRating} from "./mentraAppAgeRating"

describe("the Mentra App's own age rating", () => {
  test("is MENTRA_APP_AGE_RATING from the build's extra", () => {
    expect(mentraAppAgeRating({MENTRA_APP_AGE_RATING: "12+"})).toBe("12+")
    expect(mentraAppAgeRating({MENTRA_APP_AGE_RATING: "17+", other: true})).toBe("17+")
  })

  test("is the lowest rating, so more is gated, when the build has none it can read", () => {
    for (const extra of [
      undefined,
      null,
      {},
      {MENTRA_APP_AGE_RATING: ""},
      {MENTRA_APP_AGE_RATING: "teen"},
      {MENTRA_APP_AGE_RATING: 12},
    ]) {
      expect(mentraAppAgeRating(extra)).toBe("4+")
    }
  })
})
