import TcpSocket from "react-native-tcp-socket"

const MINISOCKET_PORT = 8765
const WS_GUID = "258EAFA5-E914-47DA-95CA-5AB9DC85B11C"

// Minimal WebSocket frame builder for binary data
function encodeWsFrame(data: Buffer, opcode: number = 0x02): Buffer {
  const len = data.length
  let header: Buffer

  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x80 | opcode // FIN + opcode
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    // Write as two 32-bit values (JS doesn't have 64-bit int writes easily)
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(len, 6)
  }

  return Buffer.concat([header, data])
}

function encodeWsTextFrame(text: string): Buffer {
  return encodeWsFrame(Buffer.from(text, "utf-8"), 0x01)
}

function encodeWsCloseFrame(): Buffer {
  return encodeWsFrame(Buffer.alloc(0), 0x08)
}

function encodeWsPongFrame(payload: Buffer): Buffer {
  return encodeWsFrame(payload, 0x0a)
}

// Parse a WebSocket frame from raw TCP data (handles masked client frames)
function decodeWsFrame(data: Buffer): {opcode: number; payload: Buffer; bytesConsumed: number} | null {
  if (data.length < 2) return null

  const opcode = data[0] & 0x0f
  const masked = (data[1] & 0x80) !== 0
  let payloadLen = data[1] & 0x7f
  let offset = 2

  if (payloadLen === 126) {
    if (data.length < 4) return null
    payloadLen = data.readUInt16BE(2)
    offset = 4
  } else if (payloadLen === 127) {
    if (data.length < 10) return null
    payloadLen = data.readUInt32BE(6) // ignore high 32 bits
    offset = 10
  }

  const maskSize = masked ? 4 : 0
  const totalLen = offset + maskSize + payloadLen
  if (data.length < totalLen) return null

  let payload: Buffer
  if (masked) {
    const mask = data.subarray(offset, offset + 4)
    payload = Buffer.alloc(payloadLen)
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = data[offset + 4 + i] ^ mask[i % 4]
    }
  } else {
    payload = Buffer.from(data.subarray(offset, offset + payloadLen))
  }

  return {opcode, payload, bytesConsumed: totalLen}
}

interface WsClient {
  socket: TcpSocket.Socket
  upgraded: boolean
  buffer: Buffer
}

class MiniSockets {
  private static instance: MiniSockets | null = null
  private server: TcpSocket.Server | null = null
  private clients: Map<number, WsClient> = new Map()
  private clientIdCounter = 0
  private running = false

  private constructor() {}

  public static getInstance(): MiniSockets {
    if (!MiniSockets.instance) {
      MiniSockets.instance = new MiniSockets()
    }
    return MiniSockets.instance
  }

  public start() {
    if (this.running) return
    this.running = true

    this.server = TcpSocket.createServer((socket) => {
      const clientId = this.clientIdCounter++
      const client: WsClient = {
        socket,
        upgraded: false,
        buffer: Buffer.alloc(0),
      }
      this.clients.set(clientId, client)
      console.log(`MINISOCKET: Client ${clientId} connected`)

      socket.on("data", (data: Buffer | string) => {
        const buf = typeof data === "string" ? Buffer.from(data) : data
        this.handleData(clientId, buf)
      })

      socket.on("error", (err) => {
        console.error(`MINISOCKET: Client ${clientId} error:`, err.message)
        this.removeClient(clientId)
      })

      socket.on("close", () => {
        console.log(`MINISOCKET: Client ${clientId} disconnected`)
        this.removeClient(clientId)
      })
    })

    this.server.listen({port: MINISOCKET_PORT, host: "127.0.0.1"}, () => {
      console.log(`MINISOCKET: Server listening on ws://127.0.0.1:${MINISOCKET_PORT}`)
    })

    this.server.on("error", (err) => {
      console.error("MINISOCKET: Server error:", err.message)
    })
  }

  public stop() {
    this.running = false
    for (const [id, client] of this.clients) {
      try {
        if (client.upgraded) {
          client.socket.write(encodeWsCloseFrame())
        }
        client.socket.destroy()
      } catch {}
    }
    this.clients.clear()
    this.server?.close()
    this.server = null
    console.log("MINISOCKET: Server stopped")
  }

  public cleanup() {
    this.stop()
    MiniSockets.instance = null
  }

  /**
   * Send raw audio data (ArrayBuffer) to all connected WebSocket clients
   */
  public sendAudio(audio: ArrayBuffer) {
    const frame = encodeWsFrame(Buffer.from(audio), 0x02) // binary frame
    for (const [id, client] of this.clients) {
      if (!client.upgraded) continue
      try {
        client.socket.write(frame)
      } catch (err: any) {
        console.error(`MINISOCKET: Error sending audio to client ${id}:`, err.message)
        this.removeClient(id)
      }
    }
  }

  /**
   * Send a JSON message to all connected WebSocket clients
   */
  public sendMessage(message: object) {
    const frame = encodeWsTextFrame(JSON.stringify(message))
    for (const [id, client] of this.clients) {
      if (!client.upgraded) continue
      try {
        client.socket.write(frame)
      } catch (err: any) {
        console.error(`MINISOCKET: Error sending message to client ${id}:`, err.message)
        this.removeClient(id)
      }
    }
  }

  public getPort(): number {
    return MINISOCKET_PORT
  }

  public isRunning(): boolean {
    return this.running
  }

  public getClientCount(): number {
    let count = 0
    for (const client of this.clients.values()) {
      if (client.upgraded) count++
    }
    return count
  }

  // --- Internal ---

  private handleData(clientId: number, data: Buffer) {
    const client = this.clients.get(clientId)
    if (!client) return

    if (!client.upgraded) {
      // Accumulate data for HTTP upgrade handshake
      client.buffer = Buffer.concat([client.buffer, data])
      const request = client.buffer.toString("utf-8")

      // Wait for full HTTP headers
      if (!request.includes("\r\n\r\n")) return

      this.handleUpgrade(clientId, request)
    } else {
      // WebSocket frame data
      client.buffer = Buffer.concat([client.buffer, data])
      this.processFrames(clientId)
    }
  }

  private handleUpgrade(clientId: number, request: string) {
    const client = this.clients.get(clientId)
    if (!client) return

    // Extract Sec-WebSocket-Key
    const keyMatch = request.match(/Sec-WebSocket-Key:\s*(.+)\r\n/i)
    if (!keyMatch) {
      console.error("MINISOCKET: Missing Sec-WebSocket-Key")
      client.socket.destroy()
      this.removeClient(clientId)
      return
    }

    const key = keyMatch[1].trim()

    // Compute accept hash: Base64(SHA1(key + GUID))
    // Use a pure-JS SHA1 since we're in RN
    const acceptKey = this.computeAcceptKey(key)

    const response = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      "",
    ].join("\r\n")

    client.socket.write(response)
    client.upgraded = true
    client.buffer = Buffer.alloc(0)
    console.log(`MINISOCKET: Client ${clientId} upgraded to WebSocket`)
  }

  private computeAcceptKey(key: string): string {
    // SHA-1 implementation for the WebSocket handshake
    const input = key + WS_GUID
    const sha1 = this.sha1(input)
    return Buffer.from(sha1, "hex").toString("base64")
  }

  private sha1(str: string): string {
    // Minimal SHA-1 for WebSocket accept key computation
    const msg = Buffer.from(str, "utf-8")

    let h0 = 0x67452301
    let h1 = 0xefcdab89
    let h2 = 0x98badcfe
    let h3 = 0x10325476
    let h4 = 0xc3d2e1f0

    const msgBitLen = msg.length * 8
    // Padding
    const padded = Buffer.alloc(Math.ceil((msg.length + 9) / 64) * 64)
    msg.copy(padded)
    padded[msg.length] = 0x80
    padded.writeUInt32BE(Math.floor(msgBitLen / 0x100000000), padded.length - 8)
    padded.writeUInt32BE(msgBitLen >>> 0, padded.length - 4)

    const rotl = (n: number, s: number) => ((n << s) | (n >>> (32 - s))) >>> 0

    for (let offset = 0; offset < padded.length; offset += 64) {
      const w = new Array<number>(80)
      for (let i = 0; i < 16; i++) {
        w[i] = padded.readUInt32BE(offset + i * 4)
      }
      for (let i = 16; i < 80; i++) {
        w[i] = rotl((w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]) >>> 0, 1)
      }

      let a = h0,
        b = h1,
        c = h2,
        d = h3,
        e = h4

      for (let i = 0; i < 80; i++) {
        let f: number, k: number
        if (i < 20) {
          f = ((b & c) | (~b & d)) >>> 0
          k = 0x5a827999
        } else if (i < 40) {
          f = (b ^ c ^ d) >>> 0
          k = 0x6ed9eba1
        } else if (i < 60) {
          f = ((b & c) | (b & d) | (c & d)) >>> 0
          k = 0x8f1bbcdc
        } else {
          f = (b ^ c ^ d) >>> 0
          k = 0xca62c1d6
        }

        const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0
        e = d
        d = c
        c = rotl(b, 30)
        b = a
        a = temp
      }

      h0 = (h0 + a) >>> 0
      h1 = (h1 + b) >>> 0
      h2 = (h2 + c) >>> 0
      h3 = (h3 + d) >>> 0
      h4 = (h4 + e) >>> 0
    }

    const hex = (n: number) => n.toString(16).padStart(8, "0")
    return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4)
  }

  private processFrames(clientId: number) {
    const client = this.clients.get(clientId)
    if (!client) return

    while (client.buffer.length > 0) {
      const frame = decodeWsFrame(client.buffer)
      if (!frame) break

      client.buffer = Buffer.from(client.buffer.subarray(frame.bytesConsumed))

      switch (frame.opcode) {
        case 0x01: // text
          try {
            const text = frame.payload.toString("utf-8")
            console.log(`MINISOCKET: Text from client ${clientId}:`, text)
          } catch {}
          break
        case 0x02: // binary
          console.log(`MINISOCKET: Binary from client ${clientId}: ${frame.payload.byteLength} bytes`)
          break
        case 0x08: // close
          try {
            client.socket.write(encodeWsCloseFrame())
          } catch {}
          client.socket.destroy()
          this.removeClient(clientId)
          return
        case 0x09: // ping
          try {
            client.socket.write(encodeWsPongFrame(frame.payload))
          } catch {}
          break
        case 0x0a: // pong
          break
      }
    }
  }

  private removeClient(clientId: number) {
    this.clients.delete(clientId)
  }
}

const miniSockets = MiniSockets.getInstance()
export default miniSockets
