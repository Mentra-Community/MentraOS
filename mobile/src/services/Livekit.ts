import {AudioSession, AndroidAudioTypePresets} from "@livekit/react-native"
import {Room, RoomEvent, ConnectionState, DisconnectReason} from "livekit-client"

import restComms from "@/services/RestComms"

class Livekit {
  private static instance: Livekit
  private room: Room | null = null
  private isConnecting = false
  private reconnectAttempts = 0
  private readonly maxReconnectAttempts = 3

  private sequence = 0

  private constructor() {}

  public static getInstance(): Livekit {
    if (!Livekit.instance) {
      Livekit.instance = new Livekit()
    }
    return Livekit.instance
  }

  private getSequence() {
    this.sequence += 1
    this.sequence = this.sequence % 256
    return this.sequence
  }

  public isRoomConnected(): boolean {
    return this.room?.state === ConnectionState.Connected
  }

  public async connect() {
    // Prevent concurrent connection attempts (fixes PeerConnection state errors)
    if (this.isConnecting) {
      console.log("LivekitManager: Connection already in progress, skipping")
      return
    }

    this.isConnecting = true
    try {
      // Clean disconnect any existing room first
      if (this.room) {
        await this.cleanupRoom()
      }

      const res = await restComms.getLivekitUrlAndToken()
      if (res.is_error()) {
        console.error("LivekitManager: Error connecting to room", res.error)
        return
      }
      const {url, token} = res.value
      console.log(`LivekitManager: Connecting to room: ${url}, ${token}`)
      this.room = new Room()
      await AudioSession.configureAudio({
        android: {
          // currently supports .media and .communication presets
          audioTypeOptions: AndroidAudioTypePresets.media,
        },
      })
      await AudioSession.startAudioSession()

      // Set up event handlers before connecting
      this.setupRoomEventHandlers()

      await this.room.connect(url, token)
      this.reconnectAttempts = 0 // Reset on successful connection
    } catch (error: any) {
      console.error("LivekitManager: Connection error", error?.message || error)
      // Handle fingerprint mismatch and other negotiation errors by retrying fresh
      if (
        error?.message?.includes("fingerprint") ||
        error?.message?.includes("NegotiationError") ||
        error?.message?.includes("PeerConnection")
      ) {
        console.log("LivekitManager: Negotiation error, will retry with fresh connection")
        await this.cleanupRoom()
      }
    } finally {
      this.isConnecting = false
    }
  }

  private setupRoomEventHandlers() {
    if (!this.room) return

    this.room.on(RoomEvent.Connected, () => {
      console.log("LivekitManager: Connected to room")
      this.reconnectAttempts = 0
    })

    this.room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      console.log("LivekitManager: Disconnected from room", reason)
      // Auto-reconnect on unexpected disconnects
      if (reason !== DisconnectReason.CLIENT_INITIATED && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++
        console.log(`LivekitManager: Attempting reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`)
        // Use setTimeout to avoid blocking and allow cleanup
        setTimeout(() => this.connect(), 1000 * this.reconnectAttempts)
      }
    })

    this.room.on(RoomEvent.Reconnecting, () => {
      console.log("LivekitManager: Reconnecting to room")
    })

    this.room.on(RoomEvent.Reconnected, () => {
      console.log("LivekitManager: Reconnected to room")
      this.reconnectAttempts = 0
    })
  }

  private async cleanupRoom() {
    if (this.room) {
      try {
        await this.room.disconnect()
      } catch {
        // Ignore disconnect errors during cleanup
        console.log("LivekitManager: Cleanup disconnect error (ignored)")
      }
      this.room = null
    }
  }

  public addPcm(data: Uint8Array) {
    // Double-check connection state to avoid "PC manager is closed" errors
    if (!this.room || this.room.state !== ConnectionState.Connected) {
      return
    }

    // prepend a sequence number:
    data = new Uint8Array([this.getSequence(), ...data])

    // Handle the promise to prevent unhandled rejection errors
    this.room.localParticipant.publishData(data, {reliable: false}).catch(error => {
      // Expected during disconnects - log but don't bubble up
      if (error?.message?.includes("PC manager is closed") || error?.message?.includes("not connected")) {
        // Silently ignore - this is expected during disconnect
        return
      }
      console.warn("LivekitManager: Failed to publish PCM data:", error?.message)
    })
  }

  async disconnect() {
    this.reconnectAttempts = this.maxReconnectAttempts // Prevent auto-reconnect
    await this.cleanupRoom()
  }
}

const livekit = Livekit.getInstance()
export default livekit
