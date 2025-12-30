import {AudioSession, AndroidAudioTypePresets} from "@livekit/react-native"
import {Room, RoomEvent, ConnectionState} from "livekit-client"

import restComms from "@/services/RestComms"

class Livekit {
  private static instance: Livekit
  private room: Room | null = null

  private sequence = 0
  private isReconnecting = false

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
    return this.room?.state === ConnectionState.Connected && !this.isReconnecting
  }

  public async connect() {
    if (this.room) {
      await this.room.disconnect()
      this.room = null
    }

    this.isReconnecting = false

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
    await this.room.connect(url, token)
    this.room.on(RoomEvent.Connected, () => {
      console.log("LivekitManager: Connected to room")
      this.isReconnecting = false
    })
    this.room.on(RoomEvent.Disconnected, () => {
      console.log("LivekitManager: Disconnected from room")
      this.isReconnecting = false
    })
    this.room.on(RoomEvent.Reconnecting, () => {
      console.log("LivekitManager: Reconnecting to room...")
      this.isReconnecting = true
    })
    this.room.on(RoomEvent.Reconnected, () => {
      console.log("LivekitManager: Reconnected to room")
      this.isReconnecting = false
    })
  }

  public async addPcm(data: Uint8Array) {
    // Don't send data if not connected or if reconnecting (buffer will fill up)
    if (!this.room || this.room.state !== ConnectionState.Connected || this.isReconnecting) {
      return
    }

    // prepend a sequence number:
    data = new Uint8Array([this.getSequence(), ...data])
    this.room?.localParticipant.publishData(data, {reliable: false})
  }

  async disconnect() {
    if (this.room) {
      await this.room.disconnect()
      this.room = null
    }
    this.isReconnecting = false
  }
}

const livekit = Livekit.getInstance()
export default livekit
