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

  it("turns a displayed value outside the surface's range into a withdrawal, never a raw value", () => {
    const report = createReportDiagnosticRender(native, "android")
    const invalid: Array<["glasses_battery" | "wifi_scan", number]> = [
      ["glasses_battery", 150],
      ["glasses_battery", 101],
      ["glasses_battery", -1],
      ["glasses_battery", 57.5],
      ["glasses_battery", Number.NaN],
      ["glasses_battery", Number.POSITIVE_INFINITY],
      ["wifi_scan", 501],
      ["wifi_scan", -3],
      ["wifi_scan", 2.5],
      ["wifi_scan", Number.NEGATIVE_INFINITY],
    ]
    for (const [surface, value] of invalid) {
      nativeReport.mockClear()
      report(surface, ["stream:5"], value)
      // Ids cannot vouch for a value the evidence cannot represent: withdraw the surface.
      expect(nativeReport.mock.calls).toEqual([[surface, [], null]])
    }
  })

  it("forwards boundary values unchanged", () => {
    const report = createReportDiagnosticRender(native, "android")
    report("glasses_battery", ["stream:1"], 0)
    report("glasses_battery", ["stream:2"], 100)
    report("wifi_scan", ["stream:3"], 0)
    report("wifi_scan", ["stream:4"], 500)
    expect(nativeReport.mock.calls).toEqual([
      ["glasses_battery", ["stream:1"], 0],
      ["glasses_battery", ["stream:2"], 100],
      ["wifi_scan", ["stream:3"], 0],
      ["wifi_scan", ["stream:4"], 500],
    ])
  })

  it("withdraws then restores across valid, out-of-range and valid readings", () => {
    const report = createReportDiagnosticRender(native, "android")
    report("glasses_battery", ["stream:5"], 57)
    report("glasses_battery", [], 150)
    report("glasses_battery", ["stream:9"], 58)
    expect(nativeReport.mock.calls).toEqual([
      ["glasses_battery", ["stream:5"], 57],
      ["glasses_battery", [], null],
      ["glasses_battery", ["stream:9"], 58],
    ])
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
