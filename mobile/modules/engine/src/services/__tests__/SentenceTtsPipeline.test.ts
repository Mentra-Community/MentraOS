/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"

import {runSentenceTtsPipeline, type SentenceAudio} from "../SentenceTtsPipeline"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return {promise, resolve}
}

describe("runSentenceTtsPipeline", () => {
  test("synthesizes the next sentence while the current sentence is playing", async () => {
    const firstPlayback = deferred<{success: boolean; completed: boolean; error: null; duration: number}>()
    const cleanupFirst = mock(() => undefined)
    const cleanupSecond = mock(() => undefined)
    const second = {audioUrl: "file://second.wav", cleanup: cleanupSecond}
    const synthesize = mock(async () => second)
    const play = mock((_audio: SentenceAudio, index: number) =>
      index === 0
        ? firstPlayback.promise
        : Promise.resolve({success: true, completed: true, error: null, duration: 800}),
    )

    const resultPromise = runSentenceTtsPipeline({
      sentences: ["First.", "Second."],
      firstAudio: {audioUrl: "file://first.wav", cleanup: cleanupFirst},
      run: {cancelled: false},
      synthesize,
      play,
    })

    await Promise.resolve()
    expect(synthesize).toHaveBeenCalledWith("Second.")
    expect(play).toHaveBeenCalledTimes(1)

    firstPlayback.resolve({success: true, completed: true, error: null, duration: 1000})
    expect(await resultPromise).toEqual({success: true, completed: true, error: null, duration: 1800})
    expect(play.mock.calls.map(([audio]) => audio.audioUrl)).toEqual(["file://first.wav", "file://second.wav"])
    expect(cleanupFirst).toHaveBeenCalledTimes(1)
    expect(cleanupSecond).toHaveBeenCalledTimes(1)
  })

  test("does not advance to the prefetched sentence after cancellation", async () => {
    const firstPlayback = deferred<{success: boolean; completed: boolean; error: null; duration: number}>()
    const cleanupSecond = mock(() => undefined)
    const run = {cancelled: false}
    const play = mock((_audio: SentenceAudio) => firstPlayback.promise)

    const resultPromise = runSentenceTtsPipeline({
      sentences: ["First.", "Second."],
      firstAudio: {audioUrl: "file://first.wav"},
      run,
      synthesize: async () => ({audioUrl: "file://second.wav", cleanup: cleanupSecond}),
      play,
    })

    await Promise.resolve()
    run.cancelled = true
    firstPlayback.resolve({success: true, completed: false, error: null, duration: 250})

    expect(await resultPromise).toEqual({success: true, completed: false, error: null, duration: 250})
    await Promise.resolve()
    expect(play).toHaveBeenCalledTimes(1)
    expect(cleanupSecond).toHaveBeenCalledTimes(1)
  })

  test("does not advance after playback is interrupted without explicit cancellation", async () => {
    const cleanupSecond = mock(() => undefined)
    const play = mock(async () => ({success: true, completed: false, error: null, duration: 125}))

    const result = await runSentenceTtsPipeline({
      sentences: ["First.", "Second."],
      firstAudio: {audioUrl: "file://first.wav"},
      run: {cancelled: false},
      synthesize: async () => ({audioUrl: "file://second.wav", cleanup: cleanupSecond}),
      play,
    })

    expect(result).toEqual({success: true, completed: false, error: null, duration: 125})
    expect(play).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(cleanupSecond).toHaveBeenCalledTimes(1)
  })
})
