import {describe, expect, it, mock} from "bun:test"

import {RecorderController} from "./RecorderController"

function makeHarness(stopTailDrainMs = 0, hasMic = true, closeMs = 0) {
  const writes: Uint8Array[] = []
  let committed = false
  let audioHandler: ((data: {data: string; sampleRate?: number}) => void) | null = null
  const writer = {
    key: "rec-test",
    write: mock(async (bytes: Uint8Array) => {
      writes.push(bytes)
    }),
    writeAt: mock(async () => {}),
    close: mock(async () => {
      if (closeMs > 0) await new Promise((resolve) => setTimeout(resolve, closeMs))
      committed = true
    }),
    abort: mock(async () => {}),
  }
  const send = mock(() => {})
  const speakerStop = mock(() => {})
  const actionHandlers = new Map<string, () => Promise<unknown>>()
  const session = {
    actions: {
      handle: mock((id: string, handler: () => Promise<unknown>) => {
        actionHandlers.set(id, handler)
        return () => actionHandlers.delete(id)
      }),
    },
    blob: {
      createWriteStream: mock(async () => writer),
      list: mock(async () =>
        committed
          ? [
              {
                key: "rec-test",
                name: "Mentra Recording.wav",
                uri: "file:///rec-test.wav",
                createdAt: 1,
                bytes: 44,
                meta: {durationMs: 0, sampleRate: 16000},
              },
            ]
          : [],
      ),
      usage: mock(async () => ({bytes: 0, count: 0, quotaBytes: 1024})),
    },
    mic: {
      hasPermission: hasMic,
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
      startRecordingAction(): Promise<unknown>
      stopRecordingAction(): Promise<unknown>
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

  it("coalesces duplicate starts onto one writer", async () => {
    const h = makeHarness()

    await Promise.all([h.controller.startRecording(), h.controller.startRecording()])

    expect(h.writes).toHaveLength(1)
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

  it("acknowledges stop before the tail-drain finishes", async () => {
    const h = makeHarness(20)
    await h.controller.startRecording()

    const stopping = h.controller.stopRecording()

    expect(h.send).toHaveBeenCalledWith("rec:stopping", {})
    expect(h.writer.close).not.toHaveBeenCalled()

    await stopping
    expect(h.send).toHaveBeenCalledWith("rec:stopped", {})
  })

  it("coalesces duplicate stops onto one finalization", async () => {
    const h = makeHarness(20)
    await h.controller.startRecording()

    await Promise.all([h.controller.stopRecording(), h.controller.stopRecording()])

    expect(h.writer.close).toHaveBeenCalledTimes(1)
  })

  it("starts a recording action and returns the active capture", async () => {
    const h = makeHarness()

    const result = await h.controller.startRecordingAction()

    expect(result).toEqual({
      status: "recording",
      recordingId: "rec-test",
      startedAt: expect.any(Number),
      paused: false,
    })
  })

  it("stops a recording action after saving the capture", async () => {
    const h = makeHarness()
    await h.controller.startRecordingAction()

    const result = await h.controller.stopRecordingAction()

    expect(result).toEqual({
      status: "stopped",
      recording: {
        id: "rec-test",
        name: "Mentra Recording.wav",
        createdAt: 1,
        bytes: 44,
        durationMs: 0,
        sampleRate: 16000,
        truncated: false,
      },
    })
    expect(h.writer.close).toHaveBeenCalledTimes(1)
  })

  it("coalesces duplicate stop actions while the recording is being saved", async () => {
    const h = makeHarness(0, true, 20)
    await h.controller.startRecordingAction()

    const firstStop = h.controller.stopRecordingAction()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const secondStop = h.controller.stopRecordingAction()

    const [firstResult, secondResult] = await Promise.all([firstStop, secondStop])
    expect(secondResult).toEqual(firstResult)
    expect(secondResult).toEqual({
      status: "stopped",
      recording: expect.objectContaining({id: "rec-test"}),
    })
    expect(h.writer.close).toHaveBeenCalledTimes(1)
  })

  it("treats stopping without an active recording as an idle no-op", async () => {
    const h = makeHarness()

    await expect(h.controller.stopRecordingAction()).resolves.toEqual({status: "idle", recording: null})
  })

  it("rejects a start action without microphone permission", async () => {
    const h = makeHarness(0, false)

    await expect(h.controller.startRecordingAction()).rejects.toThrow("Microphone permission is required")
    expect(h.writes).toEqual([])
  })
})
