/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {readBoundedBody, readBoundedByteStream} from "../boundedByteStream"

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
    expect(stream.locked).toBe(false)
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
    expect(stream.locked).toBe(false)
  })
})

describe("readBoundedBody", () => {
  const headers = (length?: number) => ({
    get: (name: string) => (name === "content-length" && length !== undefined ? String(length) : null),
  })
  const stream = (...chunks: number[][]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk))
        controller.close()
      },
    })

  test("reads a body of declared length whole, never through the stream", async () => {
    const body = stream([9])
    const bytes = await readBoundedBody(
      {headers: headers(3), body, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer},
      3,
    )
    expect([...bytes]).toEqual([1, 2, 3])
    expect(body.locked).toBe(false)
  })

  test("never touches the stream of a body it reads whole", async () => {
    const response = {
      headers: headers(1),
      get body(): ReadableStream<Uint8Array> {
        throw new Error("body was read")
      },
      arrayBuffer: async () => new Uint8Array([7]).buffer,
    }
    expect([...(await readBoundedBody(response, 1))]).toEqual([7])
  })

  test("refuses a whole body that isn't its declared length", async () => {
    const response = {headers: headers(4), body: null, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer}
    await expect(readBoundedBody(response, 8)).rejects.toThrow("response has 3 bytes, not the 4 it declared")
  })

  test("refuses a declared length over the cap before reading", async () => {
    let read = false
    const response = {headers: headers(9), body: null, arrayBuffer: async () => ((read = true), new ArrayBuffer(9))}
    await expect(readBoundedBody(response, 8)).rejects.toThrow("response exceeds 8 bytes")
    expect(read).toBe(false)
  })

  test("streams a content-encoded body, whose declared length is its compressed size", async () => {
    const response = {
      headers: {get: (name: string) => ({"content-length": "1", "content-encoding": "gzip"}[name] ?? null)},
      body: stream([1, 2], [3]),
      arrayBuffer: async () => new ArrayBuffer(0),
    }
    expect([...(await readBoundedBody(response, 3))]).toEqual([1, 2, 3])
    await expect(readBoundedBody({...response, body: stream([1, 2], [3, 4])}, 3)).rejects.toThrow(
      "response exceeds 3 bytes",
    )
  })

  test("streams a body without a declared length under the cap", async () => {
    const arrayBuffer = async () => new ArrayBuffer(0)
    expect([...(await readBoundedBody({headers: headers(), body: stream([1], [2]), arrayBuffer}, 2))]).toEqual([1, 2])
    await expect(readBoundedBody({headers: headers(), body: stream([1], [2, 3]), arrayBuffer}, 2)).rejects.toThrow(
      "response exceeds 2 bytes",
    )
  })
})
