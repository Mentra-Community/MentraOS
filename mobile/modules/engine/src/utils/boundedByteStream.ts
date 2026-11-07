/** Read a byte stream without allowing a chunked response to bypass its size cap. */
export async function readBoundedByteStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer")

  const reader = stream.getReader()
  try {
    const chunks: Uint8Array[] = []
    let received = 0
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        await reader.cancel("response exceeds host limit")
        throw new Error(`response exceeds ${maxBytes} bytes`)
      }
      chunks.push(value)
    }

    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } finally {
    reader.releaseLock()
  }
}

/** What {@link readBoundedBody} needs of a fetch response. */
export interface BoundedBodyResponse {
  headers: {get(name: string): string | null}
  body: ReadableStream<Uint8Array> | null
  arrayBuffer?: () => Promise<ArrayBuffer>
}

/**
 * Read a response's body under the same cap. Expo's streaming fetch can reorder or drop bytes as its body starts
 * streaming (on Android, the bytes queued before the first read are handed over from another thread without a lock),
 * which corrupted miniapp bundles at random. So a body whose declared length is within the cap is read whole and
 * checked against that length; only one without a declared length, or content-encoded, is streamed. `body` is read
 * only then: in Expo's fetch, its getter starts streaming, which empties what arrayBuffer() returns.
 */
export async function readBoundedBody(response: BoundedBodyResponse, maxBytes: number): Promise<Uint8Array> {
  // An encoded body's length is that of its compressed bytes, not of those fetch hands over.
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase()
  const declared = !encoding || encoding === "identity" ? Number(response.headers.get("content-length") ?? NaN) : NaN
  if (Number.isSafeInteger(declared) && declared >= 0) {
    if (declared > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`)
    if (response.arrayBuffer) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength !== declared) {
        throw new Error(`response has ${bytes.byteLength} bytes, not the ${declared} it declared`)
      }
      return bytes
    }
  }
  if (!response.body) throw new Error("response has no body")
  return readBoundedByteStream(response.body, maxBytes)
}
