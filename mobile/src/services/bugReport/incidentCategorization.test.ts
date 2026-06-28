import {buildIncidentTrigger, normalizeOptionalIncidentString} from "./incidentCategorization"

describe("normalizeOptionalIncidentString", () => {
  it("trims non-empty strings", () => {
    expect(normalizeOptionalIncidentString("  hello  ")).toBe("hello")
  })

  it("returns undefined for empty or non-string values", () => {
    expect(normalizeOptionalIncidentString("   ")).toBeUndefined()
    expect(normalizeOptionalIncidentString(undefined)).toBeUndefined()
    expect(normalizeOptionalIncidentString(7)).toBeUndefined()
  })
})

describe("buildIncidentTrigger", () => {
  it("builds manual triggers for user-initiated reports", () => {
    expect(
      buildIncidentTrigger({
        submissionMode: "USER_INITIATED",
        triggerArea: "applet_capsule_menu",
        triggerReason: "manual_bug_report",
        sourceAppletPackageName: "com.mentra.demo",
        sourceAppletName: "Demo",
      }),
    ).toEqual({
      type: "manual",
      surface: "applet_capsule_menu",
      reason: "manual_bug_report",
      sourceAppletPackageName: "com.mentra.demo",
      sourceAppletName: "Demo",
    })
  })

  it("builds automatic triggers and omits blank optional applet fields", () => {
    expect(
      buildIncidentTrigger({
        submissionMode: "AUTOMATIC",
        triggerArea: "gallery_video",
        triggerReason: "gallery_video_on_error",
        sourceAppletPackageName: "   ",
        sourceAppletName: "",
      }),
    ).toEqual({
      type: "automatic",
      area: "gallery_video",
      reason: "gallery_video_on_error",
    })
  })
})
