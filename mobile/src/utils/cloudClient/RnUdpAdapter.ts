/**
 * @fileoverview react-native-udp backed UdpSocketLike for @mentra/cloud-client.
 *
 * The cloud-client encrypts each audio frame in shared code (NaCl secretbox) and
 * hands the raw bytes here; this adapter only owns the native dgram socket and
 * sends them. Mirrors v1's UdpManager socket setup (create udp4, bind to any
 * port, send). Audio bytes never round-trip through extra JS here beyond the
 * Buffer wrap the native module needs.
 */
import dgram from "react-native-udp"
import type {UdpSocketLike} from "@mentra/cloud-client"

// Dev/QA-only UDP egress block. When set, outbound UDP sends become no-ops,
// simulating a network that drops UDP (corporate/NAT firewalls — a real
// production failure mode). The client keeps probing, gets no liveness acks,
// times out after ~3s, and falls back to WS audio. The agent bridge flips this
// to test the fallback deterministically without root/iptables. Never set in
// production.
let udpBlocked = false
export function setUdpBlocked(blocked: boolean): void {
  udpBlocked = blocked
}
export function isUdpBlocked(): boolean {
  return udpBlocked
}

export function createCloudUdpSocket(): UdpSocketLike {
  const socket = dgram.createSocket({type: "udp4"})
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
      // QA-only: simulate UDP egress being blocked so the client falls back to
      // WS audio. Drops both audio frames and liveness probes, exactly like a
      // firewall would, so the real timeout-driven fallback path runs.
      if (udpBlocked) return
      // react-native-udp accepts a Uint8Array directly and base64-encodes it
      // internally via the pure-JS `buffer` package, so we avoid
      // @craftzdog/react-native-buffer (which is backed by the QuickBase64 C++
      // TurboModule). One less native dependency in the hot audio path.
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
