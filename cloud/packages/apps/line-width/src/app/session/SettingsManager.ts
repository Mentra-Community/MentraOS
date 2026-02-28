import {UserSession} from "./UserSession"
import {convertLineWidth} from "../utils"

interface CaptionSettings {
  language: string
  languageHints: string[]
  displayLines: number
  displayWidth: number
}

export class SettingsManager {
  private readonly storage: UserSession["appSession"]["simpleStorage"]
  private readonly logger: UserSession["logger"]
  private readonly userSession: UserSession
  private readonly disposables: Array<() => void> = []

  constructor(userSession: UserSession) {
    this.userSession = userSession
    this.storage = userSession.appSession.simpleStorage
    this.logger = userSession.logger.child({service: "SettingsManager"})
  }

  // SDK settings handlers removed - we only use SimpleStorage now
  // Settings changes come from REST API calls (webview)

  async initialize(): Promise<void> {
    // Load settings from SimpleStorage or use defaults
    const language = await this.getLanguage()
    const displayLines = await this.getDisplayLines()
    const displayWidth = await this.getDisplayWidth()

    this.logger.info(`Settings initialized: language=${language}, lines=${displayLines}, width=${displayWidth}`)

    // Apply settings to processor
    await this.applyToProcessor()
  }

  async getLanguage(): Promise<string> {
    const stored = await this.storage.get("language")
    return stored || "auto"
  }

  async setLanguage(language: string): Promise<void> {
    await this.storage.set("language", language)
    this.logger.info(`Language set to: ${language}`)

    // Update processor with new language settings
    await this.applyToProcessor()

    // Broadcast settings change to all connected SSE clients
    this.broadcastSettingsUpdate()
  }

  async getLanguageHints(): Promise<string[]> {
    const stored = await this.storage.get("languageHints")
    if (!stored) return []
    try {
      return JSON.parse(stored)
    } catch {
      return []
    }
  }

  async setLanguageHints(hints: string[]): Promise<void> {
    await this.storage.set("languageHints", JSON.stringify(hints))
    this.logger.info(`Language hints set to: ${hints.join(", ")}`)

    // Broadcast settings change to all connected SSE clients
    this.broadcastSettingsUpdate()
  }

  async getDisplayLines(): Promise<number> {
    const stored = await this.storage.get("displayLines")
    if (!stored) return 5 // Default to 5 lines (hardware max)
    const parsed = parseInt(stored, 10)
    return isNaN(parsed) ? 5 : parsed
  }

  async setDisplayLines(lines: number): Promise<void> {
    if (lines < 2 || lines > 5) {
      throw new Error("Lines must be between 2 and 5")
    }
    await this.storage.set("displayLines", lines.toString())
    this.logger.info(`Display lines set to: ${lines}`)

    // Update processor with new settings
    await this.applyToProcessor()

    // Broadcast settings change to all connected SSE clients
    this.broadcastSettingsUpdate()
  }

  async getDisplayWidth(): Promise<number> {
    const stored = await this.storage.get("displayWidth")
    // Default to 2 (Wide) - use full 576px width
    // Values are 0=Narrow, 1=Medium, 2=Wide
    if (!stored) return 2
    const parsed = parseInt(stored, 10)
    // Validate it's a valid enum value (0, 1, or 2)
    if (isNaN(parsed) || parsed < 0 || parsed > 2) return 2
    return parsed
  }

  async setDisplayWidth(width: number): Promise<void> {
    // Validate width is 0, 1, or 2
    if (width < 0 || width > 2) {
      throw new Error("Width must be 0 (Narrow), 1 (Medium), or 2 (Wide)")
    }
    await this.storage.set("displayWidth", width.toString())
    this.logger.info(`Display width set to: ${width}`)

    // Update processor with new settings
    await this.applyToProcessor()

    // Broadcast settings change to all connected SSE clients
    this.broadcastSettingsUpdate()
  }

  async getAll(): Promise<CaptionSettings> {
    return {
      language: await this.getLanguage(),
      languageHints: await this.getLanguageHints(),
      displayLines: await this.getDisplayLines(),
      displayWidth: await this.getDisplayWidth(),
    }
  }

  /**
   * Broadcast settings update to all connected SSE clients
   * This ensures all open webviews stay in sync
   */
  private broadcastSettingsUpdate(): void {
    // Use the transcripts manager's SSE clients to broadcast
    // We'll send a special "settings_update" message type
    this.getAll()
      .then((settings) => {
        this.userSession.transcripts.broadcastSettingsUpdate(settings)
      })
      .catch((error) => {
        this.logger.error(`Failed to broadcast settings update: ${error}`)
      })
  }

  private async applyToProcessor(): Promise<void> {
    const language = await this.getLanguage()
    const displayLines = await this.getDisplayLines()
    let displayWidth = await this.getDisplayWidth()

    // Convert line width enum (0/1/2) to visual width units
    // Visual width calculation handles all languages automatically (no isChineseLanguage needed)
    displayWidth = convertLineWidth(displayWidth.toString())

    this.logger.info(
      `Applying settings to processor: language=${language}, lines=${displayLines}, visualWidth=${displayWidth}`,
    )

    // Update DisplayManager
    this.userSession.display.updateSettings(displayWidth, displayLines)
  }

  dispose(): void {
    this.disposables.forEach((dispose) => dispose())
  }
}
