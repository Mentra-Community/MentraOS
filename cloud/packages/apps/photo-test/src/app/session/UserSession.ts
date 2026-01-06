import {AppSession, PhotoData} from "@mentra/sdk"

const PHOTO_INTERVAL_MS = 5000 // Take a photo every 5 seconds

/**
 * UserSession - Manages photo capture for a user
 */
export class UserSession {
  static userSessions = new Map<string, UserSession>()

  private session: AppSession
  private userId: string
  private sessionId: string
  private photoInterval: NodeJS.Timeout | null = null
  private latestPhoto: PhotoData | null = null
  private photoCount = 0

  constructor(session: AppSession, userId: string, sessionId: string) {
    this.session = session
    this.userId = userId
    this.sessionId = sessionId

    // Register this session
    UserSession.userSessions.set(userId, this)
  }

  static getUserSession(userId: string): UserSession | undefined {
    return UserSession.userSessions.get(userId)
  }

  static getUserSessionIfMatches(userId: string, sessionId: string): UserSession | undefined {
    const session = UserSession.userSessions.get(userId)
    if (session && session.sessionId === sessionId) {
      return session
    }
    return undefined
  }

  async initialize(): Promise<void> {
    console.log(`[UserSession] Initializing for ${this.userId}`)

    // Show initial display
    this.session.layouts.showTextWall("📸 Photo Test Active", {durationMs: 3000})

    // Start taking photos
    this.startPhotoCapture()
  }

  private startPhotoCapture(): void {
    console.log(`[UserSession] Starting photo capture interval (${PHOTO_INTERVAL_MS}ms)`)

    // Take first photo immediately
    this.takePhoto()

    // Then take photos at interval
    this.photoInterval = setInterval(() => {
      this.takePhoto()
    }, PHOTO_INTERVAL_MS)
  }

  private async takePhoto(): Promise<void> {
    this.photoCount++
    console.log(`[UserSession] Taking photo #${this.photoCount}`)

    try {
      const photoData = await this.session.camera.requestPhoto({
        size: "medium",
      })

      this.latestPhoto = photoData
      console.log(`[UserSession] Photo #${this.photoCount} received: ${photoData.filename} (${photoData.size} bytes)`)

      // Show confirmation on glasses
      this.session.layouts.showTextWall(`📸 Photo #${this.photoCount}`, {durationMs: 1000})
    } catch (error) {
      console.error(`[UserSession] Photo #${this.photoCount} failed:`, error)
      this.session.layouts.showTextWall(`❌ Photo failed`, {durationMs: 1000})
    }
  }

  getLatestPhoto(): PhotoData | null {
    return this.latestPhoto
  }

  getPhotoCount(): number {
    return this.photoCount
  }

  getUserId(): string {
    return this.userId
  }

  dispose(): void {
    console.log(`[UserSession] Disposing session for ${this.userId}`)

    if (this.photoInterval) {
      clearInterval(this.photoInterval)
      this.photoInterval = null
    }

    UserSession.userSessions.delete(this.userId)
  }
}
