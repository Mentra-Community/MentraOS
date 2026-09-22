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
    ]) {
      expect(indexSource).not.toContain(name)
    }
  })

  it("does not allowlist wear events for public addListener", () => {
    expect(indexSource).not.toMatch(/"wear_state"/)
    expect(indexSource).not.toMatch(/"wear_tuning"/)
    expect(indexSource).not.toMatch(/"mic_tuning_state"/)
  })
})
