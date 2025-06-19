class OnboardMicrophoneManager {
  public voiceData: Subject<Uint8Array> = new Subject<Uint8Array>()
  private micCallback: MicCallback | null = null

  constructor() {}

  setMicCallback(callback: MicCallback): void {
    this.micCallback = callback
  }

  checkPermissions(): boolean {
    return true // Mock permission check
  }

  startRecording(): void {
    console.log("Starting microphone recording")
  }

  stopRecording(): void {
    console.log("Stopping microphone recording")
  }
}
