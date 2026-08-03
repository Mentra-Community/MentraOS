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

  test("converges to the final desired set under A -> B -> A -> B churn with all writes in flight", () => {
    const sync = new CloudAudioSubscriptionSync()
    // Every distinct desired set while the prior write is still in flight must
    // be sent; only exact in-flight duplicates are skipped.
    expect(sync.begin("A")).toBe(true) // A in flight
    expect(sync.begin("B")).toBe(true) // B in flight (A not yet done)
    expect(sync.begin("A")).toBe(true) // A again — different from in-flight B
    expect(sync.begin("B")).toBe(true) // B again — different from in-flight A
    expect(sync.begin("B")).toBe(false) // exact duplicate of the in-flight B — skip
    // Writes resolve in arbitrary order; the machine must never wedge.
    sync.succeeded("A")
    sync.succeeded("B")
    sync.succeeded("A")
    sync.succeeded("B")
    // Final desired B, nothing in flight -> deduped.
    expect(sync.begin("B")).toBe(false)
    // A new distinct set still goes.
    expect(sync.begin("C")).toBe(true)
  })

  test("a failed intermediate write does not strand a newer desired set", () => {
    const sync = new CloudAudioSubscriptionSync()
    expect(sync.begin("fr-FR")).toBe(true)
    sync.succeeded("fr-FR")
    expect(sync.begin("empty")).toBe(true) // teardown
    expect(sync.begin("fr-FR")).toBe(true) // re-subscribe while empty in flight
    sync.failed("empty") // teardown write failed
    sync.succeeded("fr-FR") // re-subscribe landed
    // fr-FR is applied and nothing pending -> deduped; cloud has fr-FR.
    expect(sync.begin("fr-FR")).toBe(false)
  })

  test("out-of-order completion never wedges; at worst one redundant re-send", () => {
    const sync = new CloudAudioSubscriptionSync()
    expect(sync.begin("A")).toBe(true)
    sync.succeeded("A")
    expect(sync.begin("empty")).toBe(true)
    expect(sync.begin("A")).toBe(true) // A re-desired while empty in flight
    // A completes before empty (out of order):
    sync.succeeded("A")
    sync.succeeded("empty") // lastApplied transiently becomes "empty"
    // Desiring A again re-sends (redundant, cloud version-dedups) — but NOT stuck.
    expect(sync.begin("A")).toBe(true)
  })

  test("re-sends the applied set when a different write is still in flight (A -> B -> A churn)", () => {
    // Regression: settings change makes captions go fr-FR -> [] -> fr-FR.
    // The [] write is still in flight (pending) when the fr-FR re-subscribe
    // runs, so lastAppliedKey is stale (still fr-FR). The re-subscribe MUST
    // NOT be deduped, or the cloud strands on the empty set and captions die.
    const sync = new CloudAudioSubscriptionSync()

    expect(sync.begin("transcription:fr-FR")).toBe(true)
    sync.succeeded("transcription:fr-FR") // fr-FR applied

    expect(sync.begin("empty")).toBe(true) // teardown write goes in flight...
    // ...and before it resolves, the re-subscribe recomputes fr-FR:
    expect(sync.begin("transcription:fr-FR")).toBe(true)

    // The empty write lands late; the version counter keeps fr-FR at the cloud.
    sync.succeeded("empty")
    sync.succeeded("transcription:fr-FR")
    // A later identical fr-FR with nothing in flight is still correctly deduped.
    expect(sync.begin("transcription:fr-FR")).toBe(false)
  })
})
