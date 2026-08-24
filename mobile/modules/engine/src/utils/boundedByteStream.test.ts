/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {readBoundedByteStream} from "./boundedByteStream"

describe("readBoundedByteStream", () => {
  test("joins chunks up to the byte ceiling", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3]))
        controller.close()
      },
    })

    expect([...(await readBoundedByteStream(stream, 3))]).toEqual([1, 2, 3])
  })

  test("cancels a chunked response as soon as it exceeds the ceiling", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3, 4]))
      },
      cancel() {
        cancelled = true
      },
    })

    await expect(readBoundedByteStream(stream, 3)).rejects.toThrow("response exceeds 3 bytes")
    expect(cancelled).toBe(true)
  })
})
