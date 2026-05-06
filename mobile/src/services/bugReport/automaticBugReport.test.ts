import {automaticIncidentReportDedupeShouldSkip, DEFAULT_AUTOMATIC_INCIDENT_DEDUPE_MS} from "./automaticBugReport"

jest.mock("@/services/RestComms", () => ({
  __esModule: true,
  default: {
    getCoreToken: jest.fn(),
  },
}))

jest.mock("./bugReportIncident", () => ({
  buildBugReportFeedbackDataForBug: jest.fn(),
  submitBugIncident: jest.fn(),
}))

describe("automaticIncidentReportDedupeShouldSkip", () => {
  it("skips duplicates within the dedupe window", () => {
    const registry = new Map<string, number>()
    const t0 = 1_000

    expect(automaticIncidentReportDedupeShouldSkip("k", t0, DEFAULT_AUTOMATIC_INCIDENT_DEDUPE_MS, registry)).toBe(false)
    expect(
      automaticIncidentReportDedupeShouldSkip("k", t0 + 1_000, DEFAULT_AUTOMATIC_INCIDENT_DEDUPE_MS, registry),
    ).toBe(true)
  })

  it("allows the same key again after the dedupe window expires", () => {
    const registry = new Map<string, number>()
    const t0 = 1_000

    expect(automaticIncidentReportDedupeShouldSkip("k", t0, 10_000, registry)).toBe(false)
    expect(automaticIncidentReportDedupeShouldSkip("k", t0 + 11_000, 10_000, registry)).toBe(false)
  })
})
