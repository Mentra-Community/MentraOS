import {createReportDiagnosticRender} from "../_private/diagnosticRender"

describe("reportDiagnosticRender wrapper", () => {
  const nativeReport = jest.fn(() => true)
  const native = {reportDiagnosticRender: nativeReport}

  beforeEach(() => nativeReport.mockClear())

  it("forwards an empty id list so a surface's earlier marker is invalidated", () => {
    const report = createReportDiagnosticRender(native, "android")
    expect(report("glasses_battery", [], 57)).toBe(true)
    expect(report("wifi_scan", [])).toBe(true)
    expect(nativeReport.mock.calls).toEqual([
      ["glasses_battery", [], 57],
      ["wifi_scan", [], null],
    ])
  })

  it("forwards ids with the displayed value", () => {
    createReportDiagnosticRender(native, "android")("glasses_battery", ["stream:5"], 57)
    expect(nativeReport).toHaveBeenLastCalledWith("glasses_battery", ["stream:5"], 57)
  })

  it("stays a no-op outside Android or without the native function", () => {
    expect(createReportDiagnosticRender(native, "ios")("glasses_battery", [], 57)).toBe(false)
    expect(createReportDiagnosticRender({}, "android")("glasses_battery", [], 57)).toBe(false)
    expect(nativeReport).not.toHaveBeenCalled()
  })

  it("reports failure instead of throwing when the native call throws", () => {
    const throwing = {
      reportDiagnosticRender: () => {
        throw new Error("native unavailable")
      },
    }
    expect(createReportDiagnosticRender(throwing, "android")("wifi_scan", [], 0)).toBe(false)
  })
})
