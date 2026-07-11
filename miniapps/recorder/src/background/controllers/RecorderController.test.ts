import {describe, expect, it, mock} from "bun:test"

import {RecorderController} from "./RecorderController"

function makeHarness(stopTailDrainMs = 0) {
  const writes: Uint8Array[] = []
  let audioHandler: ((data: {data: string; sampleRate?: number}) => void) | null = null
  const writer = {
    key: "rec-test",
    write: mock(async (bytes: Uint8Array) => {
      writes.push(bytes)
    }),
    writeAt: mock(async () => {}),
    close: mock(async () => {}),
    abort: mock(async () => {}),
  }
  const send = mock(() => {})
  const speakerStop = mock(() => {})
  const session = {
    blob: {
      createWriteStream: mock(async () => writer),
      list: mock(async () => []),
      usage: mock(async () => ({bytes: 0, count: 0, quotaBytes: 1024})),
    },
    mic: {
      onAudioChunk: mock((handler: typeof audioHandler) => {
        audioHandler = handler
        return () => {}
      }),
    },
    transcription: {on: mock(() => () => {})},
    speaker: {stop: speakerStop},
    display: {render: mock(async () => ({status: "rendered"}))},
  }
  const controller = new RecorderController(session as never, stopTailDrainMs)
  ;(controller as unknown as {ui: {send: typeof send}}).ui = {send}

  return {
    controller: controller as unknown as {
      startRecording(): Promise<void>
      stopRecording(): Promise<void>
      playingId: string | null
    },
    getAudioHandler: () => audioHandler,
    send,
    speakerStop,
    writer,
    writes,
  }
}

describe("RecorderController recording edges", () => {
  it("stops active playback before starting a recording", async () => {
    const h = makeHarness()
    h.controller.playingId = "old-recording"

    await h.controller.startRecording()

    expect(h.speakerStop).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledWith("rec:playback", {playingId: null})
  })

  it("accepts audio arriving during the stop tail-drain window", async () => {
    const h = makeHarness(20)
    await h.controller.startRecording()

    const stopping = h.controller.stopRecording()
    await new Promise((resolve) => setTimeout(resolve, 5))
    h.getAudioHandler()?.({data: "AQIDBA==", sampleRate: 16000})
    await stopping

    expect(h.writes.some((bytes) => Array.from(bytes).join(",") === "1,2,3,4")).toBe(true)
    expect(h.writer.close).toHaveBeenCalledTimes(1)
  })
})
