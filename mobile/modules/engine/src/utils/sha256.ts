/** SHA-256 for bundle integrity checks without requiring a native crypto module. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data)
    return bytesToHex(new Uint8Array(digest))
  }
  const hash = createIncrementalSha256()
  hash.update(bytes)
  return hash.digestHex()
}

export interface IncrementalSha256 {
  update(bytes: Uint8Array): void
  digestHex(): string
}

/** Incremental SHA-256 for streaming paths that cannot retain a whole expanded file. */
export function createIncrementalSha256(): IncrementalSha256 {
  return new Sha256State()
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
])

class Sha256State implements IncrementalSha256 {
  private readonly hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  private readonly pending = new Uint8Array(64)
  private readonly words = new Uint32Array(64)
  private pendingLength = 0
  private totalBytes = 0
  private finished = false

  update(bytes: Uint8Array): void {
    if (this.finished) throw new Error("SHA-256 state is already finalized")
    this.totalBytes += bytes.byteLength
    if (!Number.isSafeInteger(this.totalBytes * 8)) throw new Error("SHA-256 input is too large")
    let offset = 0
    if (this.pendingLength > 0) {
      const copied = Math.min(64 - this.pendingLength, bytes.byteLength)
      this.pending.set(bytes.subarray(0, copied), this.pendingLength)
      this.pendingLength += copied
      offset += copied
      if (this.pendingLength === 64) {
        this.transform(this.pending, 0)
        this.pendingLength = 0
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.transform(bytes, offset)
      offset += 64
    }
    if (offset < bytes.byteLength) {
      this.pending.set(bytes.subarray(offset), 0)
      this.pendingLength = bytes.byteLength - offset
    }
  }

  digestHex(): string {
    if (this.finished) throw new Error("SHA-256 state is already finalized")
    this.finished = true
    const bitLength = this.totalBytes * 8
    this.pending[this.pendingLength++] = 0x80
    if (this.pendingLength > 56) {
      this.pending.fill(0, this.pendingLength)
      this.transform(this.pending, 0)
      this.pendingLength = 0
    }
    this.pending.fill(0, this.pendingLength, 56)
    const view = new DataView(this.pending.buffer)
    view.setUint32(56, Math.floor(bitLength / 0x100000000), false)
    view.setUint32(60, bitLength >>> 0, false)
    this.transform(this.pending, 0)

    const output = new Uint8Array(32)
    const outputView = new DataView(output.buffer)
    for (let index = 0; index < this.hash.length; index += 1) {
      outputView.setUint32(index * 4, this.hash[index], false)
    }
    return bytesToHex(output)
  }

  private transform(bytes: Uint8Array, offset: number): void {
    const w = this.words
    for (let index = 0; index < 16; index += 1) {
      w[index] =
        (bytes[offset + index * 4] << 24) |
        (bytes[offset + index * 4 + 1] << 16) |
        (bytes[offset + index * 4 + 2] << 8) |
        bytes[offset + index * 4 + 3]
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3)
      const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10)
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0
    }
    let a = this.hash[0]
    let b = this.hash[1]
    let c = this.hash[2]
    let d = this.hash[3]
    let e = this.hash[4]
    let f = this.hash[5]
    let g = this.hash[6]
    let h = this.hash[7]
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const temp1 = (h + s1 + ((e & f) ^ (~e & g)) + SHA256_K[index] + w[index]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const temp2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    this.hash[0] = (this.hash[0] + a) >>> 0
    this.hash[1] = (this.hash[1] + b) >>> 0
    this.hash[2] = (this.hash[2] + c) >>> 0
    this.hash[3] = (this.hash[3] + d) >>> 0
    this.hash[4] = (this.hash[4] + e) >>> 0
    this.hash[5] = (this.hash[5] + f) >>> 0
    this.hash[6] = (this.hash[6] + g) >>> 0
    this.hash[7] = (this.hash[7] + h) >>> 0
  }
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
