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
