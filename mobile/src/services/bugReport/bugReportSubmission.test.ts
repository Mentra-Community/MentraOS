import {buildReportSurfaceContext, resolveFeedbackTriggerReason} from "./bugReportSubmission"

describe("resolveFeedbackTriggerReason", () => {
  it("derives the generic feedback form reason from the submitted type", () => {
    expect(resolveFeedbackTriggerReason(undefined, "bug")).toBe("manual_bug_report")
    expect(resolveFeedbackTriggerReason(undefined, "feature")).toBe("manual_feedback")
  })

  it("preserves a specific launch reason", () => {
    expect(resolveFeedbackTriggerReason(" screenshot_detected ", "bug")).toBe("screenshot_detected")
  })
})

describe("buildReportSurfaceContext", () => {
  it("records launch attribution without claiming the user selected a subject", () => {
    expect(
      buildReportSurfaceContext({
        surface: "feedback_form",
        route: "/miniapps/settings/feedback",
        source: "applet_capsule_menu",
        sourceRoute: "/applet/local",
        reason: "manual_bug_report",
        sourceAppletPackageName: " com.mentra.ai ",
        sourceAppletName: " Mentra AI ",
      }),
    ).toEqual({
      reporting: {
        surface: "feedback_form",
        route: "/miniapps/settings/feedback",
        openedFrom: {
          source: "applet_capsule_menu",
          reason: "manual_bug_report",
          route: "/applet/local",
        },
        subject: {
          packageName: "com.mentra.ai",
          name: "Mentra AI",
          attribution: "launch_context",
        },
        userSelectedSubject: false,
      },
    })
  })

  it("distinguishes an explicit subject selection", () => {
    expect(
      buildReportSurfaceContext({
        surface: "feedback_form",
        route: "/miniapps/settings/feedback",
        source: "feedback_screen",
        reason: "manual_bug_report",
        sourceAppletPackageName: "com.mentra.notes",
        userSelectedSubject: true,
      }),
    ).toMatchObject({
      reporting: {
        subject: {packageName: "com.mentra.notes", attribution: "user_selection"},
        userSelectedSubject: true,
      },
    })
  })
})
