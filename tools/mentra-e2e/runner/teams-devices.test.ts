import {expect, test} from "bun:test"
import {parseTeamsDevices} from "./teams-devices"
import {hasAdvancingLaptopMedia} from "./browser-media-diagnostics"

test("sending proof rejects the glasses microphone, stopped capture and stale counters", () => {
  const devices = parseTeamsDevices({
    schemaVersion: 1,
    microphone: "Laptop mic",
    camera: "Laptop camera",
    speaker: "Laptop speakers",
  })
  const sample = (n: number, mic = devices.microphone, state = "live") => [
    {
      index: 0,
      captures: [mic, devices.camera].map((label) => ({label, readyState: state, enabled: true, muted: false})),
      peers: [
        {
          index: 0,
          connectionState: "connected",
          stats: [
            {id: "a", type: "outbound-rtp", kind: "audio", packetsSent: n},
            {id: "v", type: "outbound-rtp", kind: "video", framesEncoded: n, bytesSent: n * 100},
          ],
        },
      ],
    },
  ]
  expect(hasAdvancingLaptopMedia(sample(1), sample(2), devices)).toBe(true)
  expect(hasAdvancingLaptopMedia(sample(1), sample(2, "Mentra_Live_03BE"), devices)).toBe(false)
  expect(hasAdvancingLaptopMedia(sample(1), sample(2, devices.microphone, "ended"), devices)).toBe(false)
  expect(hasAdvancingLaptopMedia(sample(2), sample(2), devices)).toBe(false)
  expect(() => parseTeamsDevices({...devices, microphone: "Default microphone"})).toThrow()
  expect(() => parseTeamsDevices({...devices, speaker: ""})).toThrow()
})
