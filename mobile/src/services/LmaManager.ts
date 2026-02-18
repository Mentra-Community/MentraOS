interface InstalledLma {
  packageName: string
  url: string
  running: boolean
  version: string
}

class LmaManager {
  private onlineTranscriptions: boolean = false
  private offlineTranscriptions: boolean = false
  private pcmData: boolean = false
  private installedLmas: InstalledLma[] = []

  private static instance: LmaManager | null = null
  private constructor() {
    this.initialize()
  }

  public static getInstance(): LmaManager {
    if (!LmaManager.instance) {
      LmaManager.instance = new LmaManager()
    }
    return LmaManager.instance
  }

  // read local storage to find which mini apps are installed and running
  // if any mini app needs online or offlline transcriptions, we need to feed them the necessary data
  private initialize() {}

  // download the mini app from the url and unzip it to the app's cache directory/lma/<packageName>
  public async installMiniApp(url: string) {}
}
