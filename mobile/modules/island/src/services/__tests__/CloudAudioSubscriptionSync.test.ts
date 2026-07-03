/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {CloudAudioSubscriptionSync} from "../CloudAudioSubscriptionSync"

describe("CloudAudioSubscriptionSync", () => {
  test("dedupes an identical subscription write while it is still in flight", () => {
    const sync = new CloudAudioSubscriptionSync()

    expect(sync.begin("transcription:auto")).toBe(true)
    expect(sync.begin("transcription:auto")).toBe(false)
  })

  test("keeps a failed write retryable so reconnect resync can send it again", () => {
    const sync = new CloudAudioSubscriptionSync()

    expect(sync.begin("transcription:auto")).toBe(true)
    sync.failed("transcription:auto")

    expect(sync.begin("transcription:auto")).toBe(true)
  })

  test("dedupes the same key only after the cloud write succeeds", () => {
    const sync = new CloudAudioSubscriptionSync()

    expect(sync.begin("transcription:auto")).toBe(true)
    sync.succeeded("transcription:auto")

    expect(sync.begin("transcription:auto")).toBe(false)
    expect(sync.begin("transcription:en-US")).toBe(true)
  })
})
