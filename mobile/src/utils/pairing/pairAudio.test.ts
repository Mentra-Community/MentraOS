import {AUTO_AUDIO_WAIT_MS, BT_CLASSIC_ROUTE, decidePairAudio, isClassicAudioUp, needsPairAudioCheck} from "./pairAudio"

const down = {bluetoothClassicConnected: false, bluetoothClassicProfilesConnected: false, bluetoothAudioRouted: false}
const iosLive = {platform: "ios", deviceModel: "Mentra Live", readiness: down, autoAudio: undefined, waitElapsed: false}

describe("pair audio decision", () => {
  it("keeps the route and the short auto-audio window", () => {
    expect(BT_CLASSIC_ROUTE).toBe("/pairing/btclassic")
    expect(AUTO_AUDIO_WAIT_MS).toBe(8_000)
  })

  it.each(["bluetoothClassicConnected", "bluetoothClassicProfilesConnected", "bluetoothAudioRouted"] as const)(
    "treats %s as audio up",
    (signal) => {
      expect(isClassicAudioUp({...down, [signal]: true})).toBe(true)
    },
  )

  it("treats all three signals false as audio down", () => {
    expect(isClassicAudioUp(down)).toBe(false)
  })

  it.each([undefined, false, true])("skips Pair Audio when audio is already up (auto_audio=%s)", (autoAudio) => {
    for (const waitElapsed of [false, true]) {
      expect(
        decidePairAudio({
          ...iosLive,
          readiness: {...down, bluetoothAudioRouted: true},
          autoAudio,
          waitElapsed,
        }),
      ).toBe("done")
    }
  })

  it("opens Pair Audio immediately when audio is down and auto_audio is absent or false", () => {
    expect(decidePairAudio(iosLive)).toBe("pair_audio")
    expect(decidePairAudio({...iosLive, autoAudio: false})).toBe("pair_audio")
  })

  it("waits when audio is down and auto_audio is true, then opens Pair Audio at expiry if still down", () => {
    expect(decidePairAudio({...iosLive, autoAudio: true})).toBe("wait")
    expect(decidePairAudio({...iosLive, autoAudio: true, waitElapsed: true})).toBe("pair_audio")
  })

  it("is done at expiry when audio came up during the wait", () => {
    expect(
      decidePairAudio({
        ...iosLive,
        autoAudio: true,
        waitElapsed: true,
        readiness: {...down, bluetoothClassicProfilesConnected: true},
      }),
    ).toBe("done")
  })

  it.each([
    ["android", "Mentra Live"],
    ["ios", "Even Realities G1"],
    ["ios", "Mentra Display"],
    ["web", "Mentra Live"],
  ])("never shows Pair Audio for %s %s", (platform, deviceModel) => {
    expect(needsPairAudioCheck(platform, deviceModel)).toBe(false)
    for (const autoAudio of [undefined, true]) {
      expect(decidePairAudio({...iosLive, platform, deviceModel, autoAudio})).toBe("done")
    }
  })
})
