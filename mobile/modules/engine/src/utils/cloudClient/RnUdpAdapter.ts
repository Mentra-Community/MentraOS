/**
 * @fileoverview react-native-udp backed UdpSocketLike for @mentra/cloud-client.
 *
 * The cloud-client encrypts each audio frame in shared code (NaCl secretbox) and
 * hands the raw bytes here; this adapter only owns the native dgram socket and
 * sends them. Audio bytes never round-trip through extra JS here beyond the
 * Buffer wrap the native module needs.
 */
import dgram from "react-native-udp"
import {Platform} from "react-native"
import type {UdpSocketLike} from "@mentra/cloud-client"

type CloudUdpSocket = ReturnType<typeof dgram.createSocket> & {
  on(event: "error", cb: (err: Error) => void): void
  on(event: "message", cb: (msg: Uint8Array) => void): void
}

export function createCloudUdpSocket(): UdpSocketLike {
  const socket = dgram.createSocket({type: "udp4"}) as CloudUdpSocket
  let onBytes: ((bytes: Uint8Array) => void) | null = null
  let connectStarted = false
  let closed = false
  const useConnectedSocket = Platform.OS === "ios"

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
      if (closed) return
      // UdpAudio owns one socket per peer/session. iOS queues sends behind this
      // one DNS lookup instead of resolving the host for every audio packet.
      if (useConnectedSocket && !connectStarted) {
        connectStarted = true
        socket.connect(port, host, (err?: Error) => {
          if (err && !closed) console.warn(`[cloud-client udp] connect failed: ${err.message}`)
        })
      }
      socket.send(
        bytes,
        0,
        bytes.length,
        useConnectedSocket ? undefined : port,
        useConnectedSocket ? undefined : host,
        (err?: Error) => {
          if (err && !closed) console.warn(`[cloud-client udp] send failed: ${err.message}`)
        },
      )
    },
    onMessage(cb: (bytes: Uint8Array) => void): void {
      onBytes = cb
    },
    close(): void {
      if (closed) return
      closed = true
      onBytes = null
      try {
        socket.close()
      } catch {
        /* already closed */
      }
    },
  }
}
