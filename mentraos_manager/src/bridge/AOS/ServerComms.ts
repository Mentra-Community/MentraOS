class ServerComms {
  private static instance: ServerComms | null = null
  public locationManager = {setup: () => console.log("Setting up location manager")}
  public mediaManager = {setup: () => console.log("Setting up media manager")}
  public wsManager = {
    status: new BehaviorSubject<string>("disconnected"),
    connect: () => {
      console.log("Connecting WebSocket")
      this.wsManager.status.next("connected")
    },
  }

  private serverCommsCallback: ServerCommsCallback | null = null
  private userId: string = ""
  private authToken: string = ""
  private serverUrl: string = "https://default-server.com"
  private webSocketConnected: boolean = false

  private constructor() {}

  static getInstance(): ServerComms {
    if (!ServerComms.instance) {
      ServerComms.instance = new ServerComms()
    }
    return ServerComms.instance
  }

  setServerCommsCallback(callback: ServerCommsCallback): void {
    this.serverCommsCallback = callback
  }

  setAuthCredentials(userId: string, token: string): void {
    this.userId = userId
    this.authToken = token
    console.log(`Auth credentials set for user: ${userId}`)
  }

  connectWebSocket(): void {
    console.log("Connecting to WebSocket server")
    this.webSocketConnected = true
    this.wsManager.connect()
    if (this.serverCommsCallback) {
      this.serverCommsCallback.onConnectionAck()
    }
  }

  isWebSocketConnected(): boolean {
    return this.webSocketConnected
  }

  setServerUrl(url: string): void {
    this.serverUrl = url
    console.log(`Server URL set to: ${url}`)
  }

  startApp(packageName: string): void {
    console.log(`Starting app: ${packageName}`)
  }

  stopApp(packageName: string): void {
    console.log(`Stopping app: ${packageName}`)
  }

  sendBatteryStatus(level: number, charging: boolean): void {
    console.log(`Sending battery status: ${level}%, charging: ${charging}`)
  }

  sendGlassesConnectionState(modelName: string, status: string): void {
    console.log(`Sending glasses connection state: ${modelName} - ${status}`)
  }

  sendVadStatus(isSpeaking: boolean): void {
    console.log(`Sending VAD status: ${isSpeaking ? "speaking" : "silent"}`)
  }

  sendAudioChunk(chunk: Uint8Array): void {
    console.log(`Sending audio chunk of size: ${chunk.length} bytes`)
  }
}
