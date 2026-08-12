import {describe, expect, test} from "bun:test"
import {isPermanentCaptureStatus} from "./support-telemetry.service"

describe("support telemetry delivery", () => {
  test("retries operational PostHog failures and drops only payload rejections", () => {
    for (const status of [401, 403, 404, 408, 429, 500, 503]) {
      expect(isPermanentCaptureStatus(status)).toBe(false)
    }
    for (const status of [400, 413, 422]) {
      expect(isPermanentCaptureStatus(status)).toBe(true)
    }
  })
})
