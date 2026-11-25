import {readFileSync} from "fs"
import {join} from "path"

const indexSource = readFileSync(join(__dirname, "../index.ts"), "utf8")

describe("public SDK surface", () => {
  it("does not expose wear-detection or mic-tuning commands", () => {
    for (const name of [
      "queryWearState",
      "setWearReporting",
      "setWearTuning",
      "requestWearTuning",
      "resetWearTuning",
      "setMicTuning",
      "requestMicTuningState",
      "setMicRmsTelemetry",
      "sendBesCrashReported",
    ]) {
      expect(indexSource).not.toContain(name)
    }
  })

  it("does not allowlist wear events for public addListener", () => {
    expect(indexSource).not.toMatch(/"wear_state"/)
    expect(indexSource).not.toMatch(/"wear_tuning"/)
    expect(indexSource).not.toMatch(/"mic_tuning_state"/)
  })

  it("allowlists bes_crash_detected and exports its payload type", () => {
    expect(indexSource).toMatch(/"bes_crash_detected"/)
    expect(indexSource).toMatch(/\bBesCrashDetectedEvent,/)
  })

  it("offers the glasses links only as link, with no hotspot commands or events", () => {
    expect(indexSource).not.toContain("setHotspotState")
    expect(indexSource).not.toMatch(/"hotspot_status_change"|"hotspot_error"|HotspotStatus/)
    expect(indexSource).toMatch(/^  link,$/m)
    expect(indexSource).toMatch(/\bGlassesLink, LinkState\b/)
    expect(indexSource).not.toMatch(/FastLink/)
  })
})
