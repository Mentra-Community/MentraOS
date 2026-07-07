import {buildReportTrigger, normalizeOptionalReportString} from "./bugReportCategorization"

describe("normalizeOptionalReportString", () => {
  it("trims non-empty strings", () => {
    expect(normalizeOptionalReportString("  hello  ")).toBe("hello")
  })

  it("returns undefined for empty or non-string values", () => {
    expect(normalizeOptionalReportString("   ")).toBeUndefined()
    expect(normalizeOptionalReportString(undefined)).toBeUndefined()
    expect(normalizeOptionalReportString(7)).toBeUndefined()
  })
})

describe("buildReportTrigger", () => {
  it("builds manual triggers for user-initiated reports", () => {
    expect(
      buildReportTrigger({
        triggerSource: "applet_capsule_menu",
        triggerReason: "manual_bug_report",
        sourceAppletPackageName: "com.mentra.demo",
        sourceAppletName: "Demo",
      }),
    ).toEqual({
      type: "manual",
      source: "applet_capsule_menu",
      reason: "manual_bug_report",
      sourceAppletPackageName: "com.mentra.demo",
      sourceAppletName: "Demo",
    })
  })

  it("omits blank optional applet fields", () => {
    expect(
      buildReportTrigger({
        triggerSource: "feedback_screen",
        triggerReason: "manual_bug_report",
        sourceAppletPackageName: "   ",
        sourceAppletName: "",
      }),
    ).toEqual({
      type: "manual",
      source: "feedback_screen",
      reason: "manual_bug_report",
    })
  })
})
