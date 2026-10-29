import {redirectSystemPath} from "@/app/+native-intent"

const path = "com.mentra://test/submit-incident-report?alert_id=request-1"

it("leaves the failed screen in place for an incident modal", () => {
  expect(redirectSystemPath({path, initial: false})).toBeNull()
})

it("lets a cold app complete its normal boot instead of opening an uninitialized test screen", () => {
  expect(redirectSystemPath({path, initial: true})).toBe("/")
})

it.each([
  "/home",
  "com.mentra://home",
  "com.mentra://auth/callback?code=example",
  "https://example.com/test/submit-incident-report",
])("preserves unrelated URL %s", (other) => {
  expect(redirectSystemPath({path: other, initial: false})).toBe(other)
})

it("leaves a warm app in place for an authoring install command", () => {
  const path = "com.mentra://test/load-miniapp?package=com.mentra.notes"
  expect(redirectSystemPath({path, initial: false})).toBeNull()
  expect(redirectSystemPath({path, initial: true})).toBe("/")
})

it("preserves the current screen for a passive permission status request", () => {
  const path = "com.mentra://test/permissions?request_id=read-1"
  expect(redirectSystemPath({path, initial: false})).toBeNull()
  expect(redirectSystemPath({path, initial: true})).toBe("/")
})

test("attended permission command stays with the handler instead of navigating", () => {
  expect(redirectSystemPath({path: "com.mentra://test/request-permissions?request_id=batch-1", initial: false})).toBeNull()
  expect(redirectSystemPath({path: "com.mentra://test/request-permissions?request_id=batch-1", initial: true})).toBe("/")
})

it.each([
  "com.mentra://auth/reset-password#access_token=x&refresh_token=y&type=recovery",
  "https://apps.mentraglass.com/auth/reset-password#access_token=x",
  "https://apps.mentra.glass/auth/reset-password/",
  "/auth/reset-password",
])("keeps a reset link with its handler, never opening the reset screen: %s", (link) => {
  expect(redirectSystemPath({path: link, initial: false})).toBeNull()
  expect(redirectSystemPath({path: link, initial: true})).toBe("/")
})

it("still opens the reset screen from an unrelated host's path untouched", () => {
  const other = "https://example.com/auth/reset-password"
  expect(redirectSystemPath({path: other, initial: false})).toBe(other)
})
