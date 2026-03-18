import {AppSession} from "@mentra/sdk"
import {PhotoManager} from "./managers/photo.manager"
import {TranscriptionManager} from "./managers/transcription.manager"
import {AudioManager} from "./managers/audio.manager"
import {StorageManager} from "./managers/storage.manager"
import {InputManager} from "./managers/input.manager"

/**
 * UserSession — per-user state container.
 *
 * Composes all managers and holds the glasses AppSession.
 * Created when a user connects (glasses or webview) and
 * destroyed when the session is cleaned up.
 *
 * Use static methods for session lookup:
 *   UserSession.getOrCreate(userId)
 *   UserSession.get(userId)
 *   UserSession.remove(userId)
 *
 * The sessions Map lives on globalThis to prevent the duplicate-module bug:
 * if this file gets imported via different paths (e.g., "../UserSession" vs
 * "@/backend/UserSession"), Bun treats them as separate modules — each with
 * its own static fields. globalThis is process-wide, so no matter how many
 * times the module loads, everyone shares the same Map.
 */

// Single process-wide sessions store — survives duplicate module loads
const SESSIONS_KEY = Symbol.for("mentra.mini-app.sessions")
;(globalThis as any)[SESSIONS_KEY] ??= new Map<string, UserSession>()

export class UserSession {
  /** All active sessions by userId (process-wide singleton via globalThis) */
  private static get sessions(): Map<string, UserSession> {
    return (globalThis as any)[SESSIONS_KEY]
  }

  /** Get an existing session or create a new one */
  static getOrCreate(userId: string): UserSession {
    let session = UserSession.sessions.get(userId)
    if (!session) {
      session = new UserSession(userId)
      UserSession.sessions.set(userId, session)
    }
    return session
  }

  /** Get an existing session (undefined if not found) */
  static get(userId: string): UserSession | undefined {
    return UserSession.sessions.get(userId)
  }

  /** Clean up and remove a session */
  static remove(userId: string): void {
    const session = UserSession.sessions.get(userId)
    if (session) {
      session.cleanup()
      UserSession.sessions.delete(userId)
    }
  }

  /** Active glasses connection, null when webview-only */
  appSession: AppSession | null = null

  /** Photo capture, storage, and SSE broadcasting */
  photo: PhotoManager

  /** Speech-to-text listener and SSE broadcasting */
  transcription: TranscriptionManager

  /** Text-to-speech and audio control */
  audio: AudioManager

  /** User preferences via MentraOS Simple Storage */
  storage: StorageManager

  /** Button presses and touchpad gestures */
  input: InputManager

  constructor(public readonly userId: string) {
    this.photo = new PhotoManager(this)
    this.transcription = new TranscriptionManager(this)
    this.audio = new AudioManager(this)
    this.storage = new StorageManager(this)
    this.input = new InputManager(this)
  }

  /** Wire up a glasses connection — sets up all event listeners */
  setAppSession(session: AppSession): void {
    this.appSession = session
    this.transcription.setup(session)
    this.input.setup(session)
  }

  /** Disconnect glasses but keep user alive (photos, SSE clients stay) */
  clearAppSession(): void {
    this.transcription.destroy()
    this.appSession = null
  }

  /** Nuke everything — call on full disconnect */
  cleanup(): void {
    this.transcription.destroy()
    this.photo.destroy()
    this.appSession = null
  }
}
