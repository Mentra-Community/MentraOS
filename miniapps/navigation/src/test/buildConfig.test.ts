import {describe, expect, test} from "bun:test"

import {resolveMapboxBuildToken} from "../../buildConfig"

describe("navigation build configuration", () => {
  test("uses the standalone miniapp token when configured", () => {
    expect(
      resolveMapboxBuildToken({
        NODE_ENV: "production",
        PUBLIC_MAPBOX_TOKEN: "pk.miniapp-token",
        EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "pk.mobile-token",
      }),
    ).toBe("pk.miniapp-token")
  })

  test("falls back to the Mentra App token for bundled builds", () => {
    expect(
      resolveMapboxBuildToken({
        NODE_ENV: "production",
        PUBLIC_MAPBOX_TOKEN: "  ",
        EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "pk.mobile-token",
      }),
    ).toBe("pk.mobile-token")
  })

  test.each([undefined, "", "ci-dummy-mapbox-pk-token"])(
    "rejects a missing or invalid token in production (%s)",
    (token) => {
      expect(() =>
        resolveMapboxBuildToken({
          NODE_ENV: "production",
          PUBLIC_MAPBOX_TOKEN: token,
        }),
      ).toThrow("A valid public Mapbox token is required")
    },
  )

  test("allows the dev server to provide the token at runtime", () => {
    expect(resolveMapboxBuildToken({NODE_ENV: "development"})).toBe("")
  })
})
