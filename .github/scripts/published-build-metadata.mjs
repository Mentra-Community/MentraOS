import {createHash} from "node:crypto"
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
export async function jsonArtifact(url, fetchImpl) {
  const response = await fetchImpl(url, {redirect: "error", signal: AbortSignal.timeout(30_000)})
  if (!response.ok) throw new Error(`Published metadata unavailable (HTTP ${response.status})`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Published metadata has no body")
  const chunks = []
  let size = 0
  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1024 * 1024) throw new Error("Published metadata exceeds 1 MiB")
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel()
  }
  const bytes = Buffer.concat(chunks)
  return {value: JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)), url, sha256: hash(bytes), size}
}
