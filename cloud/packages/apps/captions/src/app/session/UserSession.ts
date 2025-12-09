import {AppSession, TranscriptionData} from "@mentra/sdk"
import {TranscriptsManager} from "./TranscriptsManager"
import {SettingsManager} from "./SettingsManager"
import {DisplayManager} from "./DisplayManager"
import {languageToLocale} from "../utils/languageLocale"

export class UserSession {
  static readonly userSessions: Map<string, UserSession> = new Map<string, UserSession>()
  readonly userId: string
  readonly appSession: AppSession
  readonly logger: AppSession["logger"]
  readonly transcripts: TranscriptsManager
  readonly settings: SettingsManager
  readonly display: DisplayManager

  private transcriptionCleanup: (() => void) | null = null

  constructor(appSession: AppSession) {
    this.appSession = appSession
    this.userId = appSession.userId
    this.logger = appSession.logger
    this.transcripts = new TranscriptsManager(this)
    this.settings = new SettingsManager(this)
    this.display = new DisplayManager(this)
    UserSession.userSessions.set(this.userId, this)
  }

  /**
   * Initialize the user session with settings and transcription subscription
   * This should be called after construction to set up the session
   */
  async initialize(): Promise<void> {
    try {
      // Initialize settings first (loads from cloud)
      await this.settings.initialize()

      // Get language configuration from settings
      const language = await this.settings.getLanguage()
      const languageHints = await this.settings.getLanguageHints()
      const locale = languageToLocale(language)

      // Get display settings and update DisplayManager
      // DisplayManager expects raw enum values: 0=Narrow, 1=Medium, 2=Wide
      const displayWidth = await this.settings.getDisplayWidth()
      const displayLines = await this.settings.getDisplayLines()
      this.display.updateSettings(displayWidth, displayLines)

      // Subscribe to transcription events with language and hints
      // If "auto" mode, use "en-US" as fallback for SDK
      const subscriptionLocale = language === "auto" ? "en-US" : locale

      this.transcriptionCleanup = this.appSession.events.onTranscriptionForLanguage(
        subscriptionLocale,
        (data: TranscriptionData) => {
          // Route all transcriptions through TranscriptsManager
          this.transcripts.handleTranscription(data)
        },
        {
          hints: languageHints,
        },
      )

      this.logger.info(
        {
          language,
          locale: subscriptionLocale,
          hints: languageHints,
          displayLines,
          displayWidth,
        },
        `UserSession initialized with language ${language}`,
      )
    } catch (error) {
      this.logger.error({error}, "Error initializing UserSession, using fallback subscription")

      // Fallback: subscribe with default language (en-US) and no hints
      this.transcriptionCleanup = this.appSession.events.onTranscriptionForLanguage(
        "en-US",
        (data: TranscriptionData) => {
          this.transcripts.handleTranscription(data)
        },
      )
    }
  }

  dispose() {
    // Clean up transcription subscription
    if (this.transcriptionCleanup) {
      this.transcriptionCleanup()
      this.transcriptionCleanup = null
    }

    this.transcripts.dispose()
    this.settings.dispose()
    this.display.dispose()
    UserSession.userSessions.delete(this.userId)
  }

  public static getUserSession(userId: string): UserSession | undefined {
    return UserSession.userSessions.get(userId)
  }
}
