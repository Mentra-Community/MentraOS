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
