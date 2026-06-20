/**
 * @fileoverview react-native-udp backed UdpSocketLike for @mentra/cloud-client.
 *
 * The cloud-client encrypts each audio frame in shared code (NaCl secretbox) and
 * hands the raw bytes here; this adapter only owns the native dgram socket and
 * sends them. Audio bytes never round-trip through extra JS here beyond the
 * Buffer wrap the native module needs.
 */
import dgram from "react-native-udp"
import type {UdpSocketLike} from "@mentra/cloud-client"

type CloudUdpSocket = ReturnType<typeof dgram.createSocket> & {
  on(event: "error", cb: (err: Error) => void): void
  on(event: "message", cb: (msg: Uint8Array) => void): void
}

export function createCloudUdpSocket(): UdpSocketLike {
  const socket = dgram.createSocket({type: "udp4"}) as CloudUdpSocket
  let onBytes: ((bytes: Uint8Array) => void) | null = null

  socket.on("error", (err: Error) => {
    console.warn(`[cloud-client udp] socket error: ${err.message}`)
  })
  socket.on("message", (msg: Uint8Array) => {
    onBytes?.(new Uint8Array(msg))
  })
  // Bind to any available port so the socket is ready to send.
  socket.bind(0)

  return {
    send(bytes: Uint8Array, host: string, port: number): void {
      socket.send(bytes, 0, bytes.length, port, host, (err?: Error) => {
        if (err) console.warn(`[cloud-client udp] send failed: ${err.message}`)
      })
    },
    onMessage(cb: (bytes: Uint8Array) => void): void {
      onBytes = cb
    },
    close(): void {
      try {
        socket.close()
      } catch {
        /* already closed */
      }
    },
  }
}
