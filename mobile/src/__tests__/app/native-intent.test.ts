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
