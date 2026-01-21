/**
 * UdpAudioService - React Native UDP audio sender
 *
 * Replaces native Kotlin/Swift UDP implementations with a pure React Native solution.
 * Uses react-native-udp for cross-platform UDP socket support.
 *
 * Packet format:
 * - Bytes 0-3: userIdHash (FNV-1a hash of userId, big-endian)
 * - Bytes 4-5: sequence number (big-endian, wraps at 65535)
 * - Bytes 6+: PCM audio data (or "PING" for probe packets)
 */

import socketComms from "@/services/SocketComms"
import {BackgroundTimer} from "@/utils/timers"
import {Buffer} from "buffer"

import dgram from "react-native-udp"

const UDP_PORT = 8000
const HEADER_SIZE = 6 // 4 bytes userIdHash + 2 bytes sequence
const MAX_PACKET_SIZE = 1024 // Max UDP payload size (server limit is 1040, leave margin)
// Must be even number for 16-bit PCM (2 bytes per sample) to avoid splitting samples
const MAX_AUDIO_CHUNK_SIZE = (MAX_PACKET_SIZE - HEADER_SIZE) & ~1 // 1016 bytes (508 samples)
const PING_MAGIC = "PING"
const PING_RETRY_COUNT = 3
const PING_RETRY_INTERVAL_MS = 200
// UDP probe configuration
const UDP_RETRY_INTERVAL_MS = 5000 // Retry probe every 5s if not connected
const UDP_INITIAL_DELAY_MS = 500 // Wait before first probe to let server register user

/**
 * Compute FNV-1a hash of a string (32-bit, unsigned)
 * Uses UTF-8 byte encoding to match server-side Go implementation
 */
export function fnv1aHash(str: string): number {
  const FNV_PRIME = 0x01000193
  let hash = 0x811c9dc5

  // Convert to UTF-8 bytes (matching Go/Kotlin/Swift behavior)
  const encoder = new TextEncoder()
  const bytes = encoder.encode(str)

  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, FNV_PRIME)
  }

  return hash >>> 0 // Ensure unsigned 32-bit
}

interface UdpAudioConfig {
  host: string
  port: number
  userId: string
}

type UdpSocket = ReturnType<typeof dgram.createSocket>

class UdpManager {
  private static instance: UdpManager | null = null

  private socket: UdpSocket | null = null
  private config: UdpAudioConfig | null = null
  public userIdHash: number = 0
  private sequenceNumber: number = 0
  private isReady: boolean = false
  private isConnecting: boolean = false
  private audioEnabled: boolean = false

  // Ping state
  private pingResolve: ((available: boolean) => void) | null = null
  private pingTimeout: number | null = null
  private pingRetryCount: number = 0

  // Retry state
  private retryIntervalId: number | null = null

  // Probe state
  private probeInProgress: boolean = false

  private constructor() {}

  public static getInstance(): UdpManager {
    if (!UdpManager.instance) {
      UdpManager.instance = new UdpManager()
    }
    return UdpManager.instance
  }

  public handleAck(): void {
    // start UDP registration:
    this.registerUdpAudio(false)
  }

  /**
   * Register this user for UDP audio with the server and probe availability.
   * Uses the React Native UDP service (react-native-udp) instead of native modules.
   * UDP endpoint is provided by server in the connection_ack message.
   *
   * Flow:
   * 1. Wait initial delay to let server register user
   * 2. Configure UDP service with host, port, userId (from connection_ack)
   * 3. Send registration to server via WebSocket (so server knows our hash for routing)
   * 4. Probe UDP with multiple pings (UDP is lossy, single ping unreliable)
   * 5. Wait for WebSocket ack from server
   * 6. If ack received, enable UDP audio; otherwise start periodic retry
   *
   * @param udpHost UDP server host (provided by server in connection_ack)
   * @param udpPort UDP server port (default 8000)
   * @param isRetry Whether this is a retry attempt (skip initial delay)
   */
  private async registerUdpAudio(isRetry: boolean = false): Promise<boolean> {
    // Prevent overlapping probes
    if (this.probeInProgress) {
      // console.log("UDP: Probe already in progress, skipping")
      return false
    }

    // Skip if WebSocket disconnected
    if (!socketComms.isWebSocketConnected()) {
      // console.log("UDP: WebSocket disconnected, skipping probe")
      return false
    }

    this.probeInProgress = true

    try {
      // Wait initial delay on first attempt to let server register user
      if (!isRetry) {
        // console.log(`UDP: Waiting ${UDP_INITIAL_DELAY_MS}ms before first probe...`)
        await new Promise((resolve) => BackgroundTimer.setTimeout(resolve, UDP_INITIAL_DELAY_MS))

        // Re-check WebSocket after delay
        if (!socketComms.isWebSocketConnected()) {
          console.log("UDP: WebSocket disconnected during delay, aborting probe")
          this.probeInProgress = false
          return false
        }
      }

      console.log(`UDP: ${isRetry ? "Retry" : "Initial"} probe for ${this.config?.host}:${this.config?.port}`)

      // Send registration to server via WebSocket (so server knows our hash for routing)
      const msg = {
        type: "udp_register",
        userIdHash: this.userIdHash,
      }
      socketComms.sendText(JSON.stringify(msg))
      // console.log(`UDP: Sent registration with hash ${userIdHash}`)

      // Probe UDP with multiple retries (UDP is lossy, single ping unreliable)
      // probeWithRetries sends 3 pings at 200ms intervals, times out at 2000ms
      const udpAvailable = await this.probeWithRetries(2000)

      this.probeInProgress = false

      if (udpAvailable) {
        // console.log("UDP: Probe successful - UDP audio enabled")
        this.audioEnabled = true
        this.stopUdpRetryInterval() // Stop retrying, we're connected
        return true
      } else {
        // console.log("UDP: Probe failed - using WebSocket fallback, will retry in background")
        // Stop the UDP service when probe fails to prevent audio loss
        this.stop()
        this.audioEnabled = false

        // Start periodic retry if not already running
        this.startUdpRetryInterval()
        return false
      }
    } catch (error) {
      // console.log(`UDP: Registration error: ${error}`)
      this.probeInProgress = false
      // Ensure UDP is stopped on any error
      this.stop()
      this.audioEnabled = false

      // Start periodic retry if not already running
      this.startUdpRetryInterval()
      return false
    }
  }

  /**
   * Start periodic UDP retry interval (uses BackgroundTimer for Android background support)
   */
  private startUdpRetryInterval(): void {
    // Don't start if already running or no config
    if (this.retryIntervalId !== null || !this.config) {
      return
    }

    // console.log(`UDP: Starting periodic retry every ${UDP_RETRY_INTERVAL_MS / 1000}s`)
    this.retryIntervalId = BackgroundTimer.setInterval(() => {
      // Skip if already connected or no config
      if (this.isReady || !this.config) {
        this.stopUdpRetryInterval()
        return
      }

      // Skip if WebSocket is disconnected
      if (!socketComms.isWebSocketConnected()) {
        // console.log("UDP: Skipping retry - WebSocket disconnected")
        return
      }

      // console.log("UDP: Periodic retry attempt...")
      this.registerUdpAudio(true).catch((err) => {
        // console.log("UDP: Periodic retry failed:", err)
      })
    }, UDP_RETRY_INTERVAL_MS)
  }

  /**
   * Stop periodic UDP retry interval
   */
  private stopUdpRetryInterval(): void {
    if (this.retryIntervalId !== null) {
      // console.log("UDP: Stopping periodic retry")
      BackgroundTimer.clearInterval(this.retryIntervalId)
      this.retryIntervalId = null
    }
  }

  /**
   * Unregister UDP audio and fall back to WebSocket/LiveKit.
   */
  // public async unregisterUdpAudio(): Promise<void> {
  //   try {
  //     // Stop retry interval and reset state
  //     this.stopUdpRetryInterval()
  //     // this.udpConfig = null
  //     // this.udpProbeInProgress = false

  //     if (this.audioEnabled) {
  //       // Send unregister message
  //       const userIdHash = fnv1aHash(this.userid)
  //       const msg = {
  //         type: "udp_unregister",
  //         userIdHash: userIdHash,
  //       }
  //       ws.sendText(JSON.stringify(msg))

  //       // Stop UDP service
  //       udp.stop()
  //       this.audioEnabled = false
  //       console.log("UDP: Audio disabled")
  //     }
  //   } catch (error) {
  //     console.log(`UDP: Unregister error: ${error}`)
  //   }
  // }

  ////////////////////////////////

  /**
   * Configure the UDP sender with server details and user ID
   * This is synchronous - socket creation happens on start()
   */
  public configure(host: string, port: number = UDP_PORT, userId: string): void {
    // console.log(`UDP: Configuring for ${host}:${port}, userId=${userId}`)

    this.config = {host, port, userId}
    this.userIdHash = fnv1aHash(userId)
    this.sequenceNumber = 0

    // console.log(`UDP: Configured with userIdHash=${this.userIdHash}`)
  }

  /**
   * Start the UDP socket
   * Returns a promise that resolves when the socket is ready
   */
  public async start(): Promise<boolean> {
    if (this.isReady) {
      // console.log("UDP: Already started")
      return true
    }

    if (this.isConnecting) {
      // console.log("UDP: Connection already in progress")
      return false
    }

    if (!this.config) {
      // console.log("UDP: Cannot start - not configured")
      return false
    }

    this.isConnecting = true

    try {
      // Create UDP socket
      this.socket = dgram.createSocket({type: "udp4"})

      // Set up error handler
      this.socket.on("error", (err: Error) => {
        console.log(`UDP: Socket error: ${err.message}`)
        this.isReady = false
      })

      // Bind to any available port (we're only sending, not receiving)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Socket bind timeout"))
        }, 5000)

        this.socket!.bind(0, () => {
          clearTimeout(timeout)
          resolve()
        })

        this.socket!.once("error", (err: Error) => {
          clearTimeout(timeout)
          reject(err)
        })
      })

      this.isReady = true
      this.isConnecting = false
      // console.log("UDP: Socket started and bound")
      return true
    } catch (error) {
      // console.log(`UDP: Failed to start socket: ${error}`)
      this.isConnecting = false
      this.socket?.close()
      this.socket = null
      return false
    }
  }

  /**
   * Stop the UDP socket
   */
  public stop(): void {
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout)
      this.pingTimeout = null
    }

    if (this.pingResolve) {
      this.pingResolve(false)
      this.pingResolve = null
    }

    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        // Ignore close errors
      }
      this.socket = null
    }

    this.isReady = false
    this.isConnecting = false
    this.stopUdpRetryInterval()
    console.log("UDP: Stopped")
  }

  /**
   * Send audio data via UDP
   * @param pcmData Base64-encoded PCM audio data
   */
  public sendAudio(pcmData: string): void {
    if (!this.isReady || !this.socket || !this.config) {
      return
    }

    try {
      // Decode base64 to bytes
      const audioBytes = Buffer.from(pcmData, "base64")

      // Debug log every 100 packets to confirm audio is flowing
      const numChunks = Math.ceil(audioBytes.length / MAX_AUDIO_CHUNK_SIZE)
      if (this.sequenceNumber % 100 === 0) {
        console.log(
          `UDP: Sending audio #${this.sequenceNumber}, total=${audioBytes.length}bytes, chunks=${numChunks}, maxChunk=${MAX_AUDIO_CHUNK_SIZE} to ${this.config.host}:${this.config.port}`,
        )
      }

      // Chunk audio data if it exceeds max packet size
      let offset = 0
      while (offset < audioBytes.length) {
        const chunkSize = Math.min(MAX_AUDIO_CHUNK_SIZE, audioBytes.length - offset)
        const packet = Buffer.alloc(HEADER_SIZE + chunkSize)

        // Write userIdHash (big-endian, 4 bytes)
        packet.writeUInt32BE(this.userIdHash, 0)

        // Write sequence number (big-endian, 2 bytes)
        const seq = this.sequenceNumber & 0xffff
        packet.writeUInt16BE(seq, 4)
        this.sequenceNumber++

        // Write audio chunk
        audioBytes.copy(packet, HEADER_SIZE, offset, offset + chunkSize)

        // Send packet
        this.socket.send(packet, 0, packet.length, this.config.port, this.config.host, (err) => {
          if (err && this.sequenceNumber % 1000 === 0) {
            console.log(`UDP: Send error (sampled): ${err.message}`)
          }
        })

        offset += chunkSize
      }
    } catch (error) {
      if (this.sequenceNumber % 1000 === 0) {
        console.log(`UDP: Send error (sampled): ${error}`)
      }
    }
  }

  /**
   * Send audio data via UDP (raw bytes version)
   * @param pcmData Raw PCM audio bytes
   */
  public sendAudioRaw(pcmData: Buffer): void {
    if (!this.isReady || !this.socket || !this.config) {
      return
    }

    try {
      // Chunk audio data if it exceeds max packet size
      let offset = 0
      while (offset < pcmData.length) {
        const chunkSize = Math.min(MAX_AUDIO_CHUNK_SIZE, pcmData.length - offset)
        const packet = Buffer.alloc(HEADER_SIZE + chunkSize)

        // Write userIdHash (big-endian, 4 bytes)
        packet.writeUInt32BE(this.userIdHash, 0)

        // Write sequence number (big-endian, 2 bytes)
        const seq = this.sequenceNumber & 0xffff
        packet.writeUInt16BE(seq, 4)
        this.sequenceNumber++

        // Write audio chunk
        pcmData.copy(packet, HEADER_SIZE, offset, offset + chunkSize)

        // Send packet
        this.socket.send(packet, 0, packet.length, this.config.port, this.config.host, (err) => {
          if (err && this.sequenceNumber % 1000 === 0) {
            console.log(`UDP: Send error (sampled): ${err.message}`)
          }
        })

        offset += chunkSize
      }
    } catch (error) {
      if (this.sequenceNumber % 1000 === 0) {
        console.log(`UDP: Send error (sampled): ${error}`)
      }
    }
  }

  /**
   * Send UDP ping(s) to probe connectivity
   * Sends multiple pings with retries for reliability (UDP is lossy)
   *
   * @returns Promise that resolves when ping is sent (ack comes via WebSocket)
   */
  public async sendPing(): Promise<boolean> {
    if (!this.config) {
      console.log("UDP: Cannot send ping - not configured")
      return false
    }

    // Start socket if needed
    if (!this.isReady) {
      const started = await this.start()
      if (!started) {
        return false
      }
    }

    if (!this.socket) {
      console.log("UDP: Cannot send ping - socket not available")
      return false
    }

    return new Promise((resolve) => {
      // Create ping packet: userIdHash + seq(0) + "PING"
      const pingMagicBytes = Buffer.from(PING_MAGIC, "ascii")
      const packet = Buffer.alloc(HEADER_SIZE + pingMagicBytes.length)

      // Write userIdHash (big-endian, 4 bytes)
      packet.writeUInt32BE(this.userIdHash, 0)

      // Write sequence 0 for ping
      packet.writeUInt16BE(0, 4)

      // Write "PING" magic
      pingMagicBytes.copy(packet, HEADER_SIZE)

      // console.log(`UDP: Sending ping to ${this.config!.host}:${this.config!.port}`)

      this.socket!.send(packet, 0, packet.length, this.config!.port, this.config!.host, (err) => {
        if (err) {
          console.log(`UDP: Failed to send ping: ${err.message}`)
          resolve(false)
        } else {
          // console.log("UDP: Ping sent successfully")
          resolve(true)
        }
      })
    })
  }

  /**
   * Send multiple pings with retry for reliability
   * UDP is lossy, so a single ping may not arrive
   *
   * @param onAckReceived Callback when server ack is received via WebSocket
   * @param timeoutMs Total timeout for all retries
   * @returns Promise that resolves to true if any ping was acked
   */
  public probeWithRetries(timeoutMs: number = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      // Store resolve for when ack arrives via WebSocket
      this.pingResolve = resolve
      this.pingRetryCount = 0

      // Set overall timeout
      this.pingTimeout = setTimeout(() => {
        console.log("UDP: Probe timed out after all retries")
        this.pingResolve = null
        this.pingTimeout = null
        resolve(false)
      }, timeoutMs)

      // Send first ping and schedule retries
      this.sendPingWithRetry()
    })
  }

  private sendPingWithRetry(): void {
    if (this.pingRetryCount >= PING_RETRY_COUNT) {
      return // All retries exhausted, wait for timeout
    }

    this.pingRetryCount++
    // console.log(`UDP: Sending ping attempt ${this.pingRetryCount}/${PING_RETRY_COUNT}`)

    this.sendPing()
      .then((sent) => {
        if (!sent) {
          console.log("UDP: Ping send failed, retrying...")
        }

        // Schedule next retry if we haven't received ack yet
        if (this.pingResolve && this.pingRetryCount < PING_RETRY_COUNT) {
          setTimeout(() => {
            if (this.pingResolve) {
              this.sendPingWithRetry()
            }
          }, PING_RETRY_INTERVAL_MS)
        }
      })
      .catch((err) => {
        console.log(`UDP: Ping error: ${err}`)
      })
  }

  /**
   * Called when ping ack is received via WebSocket
   * This confirms UDP connectivity is working
   */
  public onPingAckReceived(): void {
    console.log("UDP: Ping ack received - UDP is working")

    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout)
      this.pingTimeout = null
    }

    if (this.pingResolve) {
      this.pingResolve(true)
      this.pingResolve = null
    }
  }

  /**
   * Get the current user ID hash
   */
  public getUserIdHash(): number {
    return this.userIdHash
  }

  /**
   * Check if UDP is configured and ready to send
   */
  public enabledAndReady(): boolean {
    return this.isReady && this.socket !== null && this.config !== null && this.audioEnabled
  }

  /**
   * Check if UDP has been configured (may not be ready yet)
   */
  public isConfigured(): boolean {
    return this.config !== null
  }

  /**
   * Get the current UDP endpoint (host:port) or null if not configured
   */
  public getEndpoint(): string | null {
    if (!this.config) {
      return null
    }
    return `${this.config.host}:${this.config.port}`
  }

  /**
   * Cleanup - stop socket and reset state
   */
  public cleanup(): void {
    this.stop()
    this.config = null
    this.userIdHash = 0
    this.sequenceNumber = 0

    UdpManager.instance = null
  }
}

// Export singleton instance
const udpManager = UdpManager.getInstance()
export default udpManager
