import {describe, expect, it, mock} from "bun:test"

import {RecorderController} from "./RecorderController"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise, resolve, reject}
}

function playbackMeta(id: string) {
  return {uri: `file:///${id}.wav`, meta: {durationMs: 10000}}
}

function makePlaybackHarness() {
  const send = mock((_channel: string, _payload: unknown) => {})
  const get = mock(async (id: string): Promise<ReturnType<typeof playbackMeta> | null> => playbackMeta(id))
  const completions: ReturnType<typeof deferred<void>>[] = []
  const play = mock((_options: {audioUrl: string; startPositionMs?: number; stopOtherAudio?: boolean}) => {
    const completion = deferred<void>()
    completions.push(completion)
    return completion.promise
  })
  const stop = mock(() => {})
  const controller = new RecorderController({blob: {get}, speaker: {play, stop}} as never) as unknown as {
    ui: {send: typeof send}
    play(id: string, positionMs?: number): Promise<void>
    stopPlay(): void
    playingId: string | null
  }
  controller.ui = {send}
  return {controller, send, get, play, stop, completions}
}

describe("RecorderController playback ownership", () => {
  for (const failure of ["missing", "unreadable"] as const) {
    it(`clears completed playback after another recording is ${failure}`, async () => {
      const h = makePlaybackHarness()
      const playingA = h.controller.play("A")
      await Promise.resolve()
      h.get.mockImplementationOnce(async () => {
        if (failure === "unreadable") throw new Error("Unreadable blob")
        return null
      })

      await h.controller.play("B")
      expect(h.send).toHaveBeenCalledWith("rec:audio-missing", {id: "B"})
      expect(h.controller.playingId).toBe("A")
      expect(h.play).toHaveBeenCalledTimes(1)
      h.completions[0].resolve()
      await playingA
      expect(h.controller.playingId).toBeNull()
      expect(h.send).toHaveBeenLastCalledWith("rec:playback", {playingId: null, positionMs: 0})
    })
  }

  it("clears finished audio while the next recording is still loading", async () => {
    const h = makePlaybackHarness()
    const playingA = h.controller.play("A")
    await Promise.resolve()
    const lookupB = deferred<ReturnType<typeof playbackMeta> | null>()
    h.get.mockImplementationOnce(() => lookupB.promise)
    const playingB = h.controller.play("B", 4000)

    h.completions[0].resolve()
    await playingA
    expect(h.controller.playingId).toBeNull()
    lookupB.resolve(playbackMeta("B"))
    await Promise.resolve()
    expect(h.controller.playingId).toBe("B")
    expect(h.play).toHaveBeenLastCalledWith({audioUrl: "file:///B.wav", startPositionMs: 4000, stopOtherAudio: true})
    h.completions[1].resolve()
    await playingB
    expect(h.controller.playingId).toBeNull()
  })

  it("keeps replacement playback active when the previous audio completes", async () => {
    const h = makePlaybackHarness()
    const playingA = h.controller.play("A")
    await Promise.resolve()
    const playingB = h.controller.play("B")
    await Promise.resolve()
    h.completions[0].resolve()
    await playingA
    expect(h.controller.playingId).toBe("B")
    h.completions[1].resolve()
    await playingB
    expect(h.controller.playingId).toBeNull()
  })

  it("cancels pending lookups on stop and ignores older playback completion", async () => {
    const h = makePlaybackHarness()
    const playingA = h.controller.play("A")
    await Promise.resolve()
    const lookupB = deferred<ReturnType<typeof playbackMeta> | null>()
    h.get.mockImplementationOnce(() => lookupB.promise)
    const playingB = h.controller.play("B")
    h.controller.stopPlay()
    expect(h.stop).toHaveBeenCalledTimes(1)
    expect(h.controller.playingId).toBeNull()

    const playingC = h.controller.play("C")
    await Promise.resolve()
    lookupB.resolve(playbackMeta("B"))
    await playingB
    h.completions[0].resolve()
    await playingA
    expect(h.play).toHaveBeenCalledTimes(2)
    expect(h.controller.playingId).toBe("C")
    h.completions[1].resolve()
    await playingC
  })

  it("ignores an older lookup after a newer play request", async () => {
    const h = makePlaybackHarness()
    const lookupA = deferred<ReturnType<typeof playbackMeta> | null>()
    h.get.mockImplementationOnce(() => lookupA.promise)
    const playingA = h.controller.play("A")
    const playingB = h.controller.play("B")
    await Promise.resolve()
    lookupA.resolve(playbackMeta("A"))
    await playingA
    expect(h.play).toHaveBeenCalledTimes(1)
    expect(h.controller.playingId).toBe("B")
    h.completions[0].resolve()
    await playingB
  })
})

function makeHarness(
  hasMic = true,
  closeMs = 0,
  shareResult: {success: boolean; cancelled?: boolean} = {success: true},
  minimumSavingMs = 0,
  stopTailDrainMs = 0,
) {
  const writes: Uint8Array[] = []
  let committed = false
  let audioHandler: ((data: {data: string; sampleRate?: number}) => void) | null = null
  const writer = {
    key: "rec-test",
    write: mock(async (bytes: Uint8Array) => {
      writes.push(bytes)
    }),
    writeAt: mock(async (_offset: number, _bytes: Uint8Array) => {}),
    close: mock(async () => {
      if (closeMs > 0) await new Promise((resolve) => setTimeout(resolve, closeMs))
      committed = true
    }),
    abort: mock(async () => {}),
  }
  const send = mock((_channel: string, _payload: unknown) => {})
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
      share: mock(async () => shareResult),
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
  const controller = new RecorderController(session as never, minimumSavingMs, stopTailDrainMs)
  ;(controller as unknown as {ui: {send: typeof send}}).ui = {send}

  return {
    controller: controller as unknown as {
      startRecording(): Promise<void>
      stopRecording(): Promise<void>
      startRecordingAction(): Promise<unknown>
      stopRecordingAction(): Promise<unknown>
      exportRecording(id: string): Promise<void>
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
    expect(h.send).toHaveBeenCalledWith("rec:playback", {playingId: null, positionMs: 0})
  })

  it("timestamps raw waveform slices even while a blob write is pending", async () => {
    const h = makeHarness()
    await h.controller.startRecording()
    let finishWrite!: () => void
    h.writer.write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        }),
    )
    const audio = h.getAudioHandler()!
    audio({data: Buffer.alloc(49152).toString("base64"), sampleRate: 16000})
    await Promise.resolve()
    audio({data: Buffer.alloc(1600, Buffer.from([0, 64])).toString("base64"), sampleRate: 16000})
    const events = h.send.mock.calls.filter(([channel]) => channel === "rec:waveform")
    expect(events).toHaveLength(2)
    expect(events[0][1]).toEqual({ms: 1536, level: 0})
    expect(events[1][1]).toEqual({ms: 1586, level: 0.5})
    finishWrite()
    await h.controller.stopRecording()
  })

  it("coalesces duplicate starts onto one writer", async () => {
    const h = makeHarness()

    await Promise.all([h.controller.startRecording(), h.controller.startRecording()])

    expect(h.writes).toHaveLength(1)
  })

  it("stops capture immediately, preserves buffered PCM, and rejects late frames", async () => {
    const h = makeHarness(true, 20)
    await h.controller.startRecording()
    const audio = h.getAudioHandler()!
    audio({data: "AQIDBA==", sampleRate: 16000})

    const stopping = h.controller.stopRecording()
    const statusCount = h.send.mock.calls.filter(([channel]) => channel === "rec:status").length
    audio({data: Buffer.alloc(6400, 9).toString("base64"), sampleRate: 16000})

    expect(h.send).toHaveBeenCalledWith("rec:stopping", {})
    expect(h.send.mock.calls.filter(([channel]) => channel === "rec:status")).toHaveLength(statusCount)
    await stopping

    expect(h.writes[1]).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(h.writer.writeAt.mock.calls[0][1].byteLength).toBe(44)
    const header = h.writer.writeAt.mock.calls[0][1] as Uint8Array
    expect(new DataView(header.buffer, header.byteOffset).getUint32(40, true)).toBe(4)
    expect(h.writer.close).toHaveBeenCalledTimes(1)
  })

  it("keeps saving visible until the committed recording is in the list", async () => {
    const h = makeHarness(true, 20)
    await h.controller.startRecording()
    const stopping = h.controller.stopRecording()

    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.writer.close).toHaveBeenCalledTimes(1)
    expect(h.send).not.toHaveBeenCalledWith("rec:stopped", {})
    await stopping
    const channels = h.send.mock.calls.map(([channel]) => channel)
    expect(channels.indexOf("rec:list")).toBeLessThan(channels.indexOf("rec:stopped"))
  })

  it("keeps the timer frozen during the minimum saving feedback", async () => {
    const h = makeHarness(true, 0, {success: true}, 40)
    await h.controller.startRecording()
    const stopping = h.controller.stopRecording()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.writer.close).toHaveBeenCalledTimes(1)
    expect(h.send).not.toHaveBeenCalledWith("rec:stopped", {})
    const count = h.send.mock.calls.filter(([channel]) => channel === "rec:status").length
    h.getAudioHandler()?.({data: Buffer.alloc(6400).toString("base64"), sampleRate: 16000})
    expect(h.send.mock.calls.filter(([channel]) => channel === "rec:status")).toHaveLength(count)
    await stopping
    expect(h.send).toHaveBeenCalledWith("rec:stopped", {})
  })

  it("preserves tail audio without advancing the saving timer", async () => {
    const h = makeHarness(true, 0, {success: true}, 0, 20)
    await h.controller.startRecording()
    const stopping = h.controller.stopRecording()
    const count = h.send.mock.calls.filter(([channel]) => channel === "rec:status").length
    h.getAudioHandler()?.({data: Buffer.alloc(6400, 7).toString("base64"), sampleRate: 16000})
    expect(h.send.mock.calls.filter(([channel]) => channel === "rec:status")).toHaveLength(count)
    await stopping
    expect(h.writes[1]).toEqual(new Uint8Array(6400).fill(7))
  })

  it("coalesces duplicate stops onto one finalization", async () => {
    const h = makeHarness(true, 20)
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
    const h = makeHarness(true, 20)
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
    const h = makeHarness(false)

    await expect(h.controller.startRecordingAction()).rejects.toThrow("Microphone permission is required")
    expect(h.writes).toEqual([])
  })

  it("surfaces a non-cancelled share failure", async () => {
    const h = makeHarness(true, 0, {success: false})

    await h.controller.exportRecording("rec-test")

    expect(h.send).toHaveBeenCalledWith("rec:share-failed", {id: "rec-test"})
  })

  it("does not surface share-sheet cancellation as an error", async () => {
    const h = makeHarness(true, 0, {success: false, cancelled: true})

    await h.controller.exportRecording("rec-test")

    expect(h.send).not.toHaveBeenCalledWith("rec:share-failed", {id: "rec-test"})
  })
})
