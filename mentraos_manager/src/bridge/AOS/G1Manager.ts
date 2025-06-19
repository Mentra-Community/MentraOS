class G1Manager {
  public g1Ready: boolean = false
  public leftReady: boolean = false
  public rightReady: boolean = false
  public isHeadUp: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false)
  public batteryLevel: BehaviorSubject<number> = new BehaviorSubject<number>(-1)
  public compressedVoiceData: Subject<Uint8Array> = new Subject<Uint8Array>()
  public onConnectionStateChanged: (() => void) | null = null
  public DEVICE_SEARCH_ID: string = ""

  constructor() {}

  RN_startScan(): void {
    console.log("Starting scan for devices")
  }

  RN_pairById(deviceId: string): void {
    console.log(`Pairing with device ID: ${deviceId}`)
  }

  RN_sendText(text: string): void {
    console.log(`Sending text to device: ${text}`)
  }

  RN_sendDoubleTextWall(topText: string, bottomText: string): void {
    console.log(`Sending double text wall: ${topText} | ${bottomText}`)
  }

  RN_getBatteryStatus(): void {
    console.log("Getting battery status")
  }

  RN_setHeadUpAngle(angle: number): void {
    console.log(`Setting head-up angle to: ${angle}`)
  }

  RN_setBrightness(brightness: number, autoMode: boolean): void {
    console.log(`Setting brightness to: ${brightness}, auto: ${autoMode}`)
  }

  async RN_setDashboardPosition(height: number, depth: number): Promise<void> {
    console.log(`Setting dashboard position - height: ${height}, depth: ${depth}`)
  }

  async RN_showDashboard(): Promise<void> {
    console.log("Showing dashboard")
  }

  async setMicEnabled(enabled: boolean): Promise<void> {
    console.log(`Setting microphone enabled: ${enabled}`)
  }

  async setSilentMode(enabled: boolean): Promise<void> {
    console.log(`Setting silent mode: ${enabled}`)
  }

  async getBatteryStatus(): Promise<void> {
    console.log("Getting battery status")
    this.batteryLevel.next(85) // Mock battery level
  }

  disconnect(): void {
    console.log("Disconnecting from device")
    this.g1Ready = false
    if (this.onConnectionStateChanged) {
      this.onConnectionStateChanged()
    }
  }
}
