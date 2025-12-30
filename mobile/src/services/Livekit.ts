import {AudioSession, AndroidAudioTypePresets} from "@livekit/react-native"
import {Room, RoomEvent, ConnectionState} from "livekit-client"

import restComms from "@/services/RestComms"

class Livekit {
  private static instance: Livekit
  private room: Room | null = null

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
    // disconnect first:
    this.disconnect()

    const res = await restComms.getLivekitUrlAndToken()
    if (res.is_error()) {
      console.error("LIVEKIT: Error connecting to room", res.error)
      return
    }
    const {url, token} = res.value
    console.log(`LIVEKIT: Connecting to room: ${url}, ${token}`)
    await AudioSession.configureAudio({
      android: {
        // currently supports .media and .communication presets
        audioTypeOptions: AndroidAudioTypePresets.media,
      },
    })
    await AudioSession.startAudioSession()
    this.room = new Room()
    await this.room?.connect(url, token)
    this.room?.on(RoomEvent.Connected, () => {
      console.log("LIVEKIT: Connected to room")
    })
    this.room?.on(RoomEvent.Reconnected, () => {
      console.log("LIVEKIT: Reconnected to room")
    })
    this.room?.on(RoomEvent.Reconnecting, () => {
      console.log("LIVEKIT: Reconnecting to room")
    })
    this.room?.on(RoomEvent.EncryptionError, (error) => {
      console.log("LIVEKIT: Encryption error", error)
    })
    this.room?.on(RoomEvent.ParticipantConnected, (participant) => {
      console.log("LIVEKIT: Participant connected", participant.identity)
    })
    this.room?.on(RoomEvent.ParticipantDisconnected, (participant) => {
      console.log("LIVEKIT: Participant disconnected", participant.identity)
    })
    this.room?.on(RoomEvent.MediaDevicesChanged, () => {
      console.log("LIVEKIT: Media devices changed")
    })
    this.room?.on(RoomEvent.MediaDevicesError, (error) => {
      console.log("LIVEKIT: Media devices error", error)
    })
    this.room?.on(RoomEvent.Disconnected, () => {
      console.log("LIVEKIT: Disconnected from room")
    })
  }

  public async addPcm(data: Uint8Array) {
    // Don't send data if not connected
    if (!this.room || this.room.state !== ConnectionState.Connected) {
      return
    }

    // prepend a sequence number:
    data = new Uint8Array([this.getSequence(), ...data])
    this.room?.localParticipant.publishData(data, {reliable: false})
  }

  async disconnect() {
    if (this.room) {
      try {
        await this.room.disconnect()
      } catch (error) {
        console.error("LIVEKIT: Error disconnecting from room", error)
      }
      this.room = null
    }
    this.isReconnecting = false
  }
}

const livekit = Livekit.getInstance()
export default livekit
