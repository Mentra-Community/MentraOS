import ws from "@/services/WebSocketManager"
import {useSettingsStore} from "@/stores/settings"
import {logE2EMetric} from "@/utils/e2eMetrics"

class SocketComms {
  private static instance: SocketComms | null = null
  private coreToken: string = ""
  public userid: string = ""

  private constructor() {}

  private setupListeners() {
    ws.removeAllListeners("message")
    ws.on("message", (message) => {
      this.handle_message(message)
    })
  }

  public static getInstance(): SocketComms {
    if (!SocketComms.instance) {
      SocketComms.instance = new SocketComms()
    }

    return SocketComms.instance
  }

  public async cleanup() {
    console.log("SOCKET: cleanup()")
    await ws.cleanup()
  }

  // Connection Management

  public async connectWebsocket() {
    console.log("SOCKET: connectWebsocket()")
    this.setupListeners()
    const url = useSettingsStore.getState().getWsUrl()
    const backendUrl = useSettingsStore.getState().getRestUrl()
    if (!url) {
      console.error(`SOCKET: Invalid server URL`)
      return
    }
    logE2EMetric("backend_config", {
      backend_url: backendUrl,
      ws_url: url,
    })
    await ws.connect(url, this.coreToken)
  }

  public isWebSocketConnected(): boolean {
    return ws.isConnected()
  }

  public async restartConnection() {
    console.log(`SOCKET: restartConnection()`)
    if (ws.isConnected()) {
      await ws.disconnect()
      await this.connectWebsocket()
    } else {
      await this.connectWebsocket()
    }
  }

  public setAuthCreds(coreToken: string, userid: string) {
    console.log(`SOCKET: setAuthCreds(): ${coreToken.substring(0, 10)}..., ${userid}`)
    this.coreToken = coreToken
    this.userid = userid
    // Keep the legacy Cloud V1 token private to SocketComms. Cloud V2 report
    // auth is synced into the Bluetooth core_token slot by island.
    // this.connectWebsocket()
  }

  private handle_connection_error(msg: any) {
    console.error("SOCKET: connection error", msg)
  }

  private handle_auth_error() {
    console.error("SOCKET: auth error")
  }

  // Message Handling
  //
  // The Cloud V1 app bridge (display events, photo/stream/video commands,
  // RGB LED control, location commands, camera FOV, WiFi setup prompts) was
  // removed when Cloud V1 apps reached end-of-life. Local miniapps never rode
  // this socket — they are served by the island runtime + Cloud V2 client.
  private handle_message(msg: any) {
    const type = msg.type

    switch (type) {
      case "ping":
        // do nothing
        break

      case "connection_ack":
      case "app_state_change":
      case "app_started":
      case "app_stopped":
        // Legacy cloud-v1 message types — ignored.
        break

      case "connection_error":
        this.handle_connection_error(msg)
        break

      case "auth_error":
        this.handle_auth_error()
        break

      case "data_stream":
        // Local island miniapps are powered ONLY by the cloud client and
        // device-sourced events, never by the v1 cloud socket. The cloud client
        // (the `@mentra/island` runtime + cloudClient adapter) owns transcript/
        // translation delivery to them, with on-device STT as the cloud-down
        // fallback. v1 cloud `data_stream` messages must NOT reach local
        // miniapps, so there is no forward here.
        break

      default:
        console.log(`SOCKET: Unknown message type: ${type} / full: ${JSON.stringify(msg)}`)
    }
  }
}

const socketComms = SocketComms.getInstance()
export default socketComms
