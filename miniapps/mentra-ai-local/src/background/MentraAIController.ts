/**
 * MentraAIController — the always-on Mentra AI logic for the local miniapp.
 *
 * Replaces the cloud app's AppServer + SessionManager + User. Because this runs
 * on one phone for one user, there's no session map, no auth, no grace-period
 * reconnect handling — a single controller owns every manager and lives for the
 * whole session. Closing the chat webview does NOT stop the assistant.
 *
 * Wiring:
 *  - transcription.on → wake word → silence-finalized query → QueryProcessor
 *  - QueryProcessor emits chat events → session.ui.send("chat:event", …)
 *  - webview RPC (history / settings / theme / clear) → session.ui.handle(…)
 *  - phone notifications → NotificationManager (prompt context)
 */

import type {MiniappSession} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {ChatEvent} from "../shared/types"

import {AudioManager} from "./managers/AudioManager"
import {ChatHistoryManager} from "./managers/ChatHistoryManager"
import {DisplayManager} from "./managers/DisplayManager"
import {LocationManager} from "./managers/LocationManager"
import {NotificationManager} from "./managers/NotificationManager"
import {PhotoManager} from "./managers/PhotoManager"
import {QueryProcessor} from "./managers/QueryProcessor"
import {StorageManager} from "./managers/StorageManager"
import {TranscriptionManager} from "./managers/TranscriptionManager"

export class MentraAIController {
  private readonly ui: import("@mentra/miniapp/background").UIModule<Channels>

  private readonly audio: AudioManager
  private readonly display: DisplayManager
  private readonly location: LocationManager
  private readonly notifications: NotificationManager
  private readonly photo: PhotoManager
  private readonly storage: StorageManager
  private readonly chatHistory: ChatHistoryManager
  private readonly transcription: TranscriptionManager
  private readonly query: QueryProcessor

  private unsubs: Array<() => void> = []
  private started = false

  constructor(private readonly session: MiniappSession) {
    this.ui = session.ui as unknown as import("@mentra/miniapp/background").UIModule<Channels>

    this.audio = new AudioManager(session)
    this.display = new DisplayManager(session)
    this.location = new LocationManager()
    this.notifications = new NotificationManager()
    this.photo = new PhotoManager(session)
    this.storage = new StorageManager(session)
    this.chatHistory = new ChatHistoryManager()

    this.query = new QueryProcessor({
      session,
      audio: this.audio,
      display: this.display,
      location: this.location,
      notifications: this.notifications,
      photo: this.photo,
      chatHistory: this.chatHistory,
      emit: (event) => this.emit(event),
    })

    this.transcription = new TranscriptionManager(session, this.photo, {
      onQueryReady: async (q, speakerId, prePhoto) => {
        await this.query.processQuery(q, speakerId, prePhoto)
      },
      onWakeWord: () => {
        this.emit({type: "wake_word"})
        this.audio.playStartSound()
      },
      onListeningUpdate: (full) => this.display.showStatus(`Listening...\n\n${full}`, 5000),
      // Feed the debug overlay's live transcription tab (every event, raw).
      onTranscript: (text, isFinal) => this.ui.send("debug:transcript", {text, isFinal}),
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    // Load persisted settings before anything reads them.
    const settings = await this.storage.load()
    this.chatHistory.setChatHistoryEnabled(settings.chatHistoryEnabled)

    this.transcription.setup()
    this.wireNotifications()
    this.wireRpcHandlers()
    this.wireUILifecycle()

    this.display.showWelcome()

    this.session.onBeforeDisconnect(() => this.dispose())
  }

  // ── notifications → prompt context ──────────────────────────────
  private wireNotifications(): void {
    if (!this.session.phone.notifications.hasPermission) return
    this.unsubs.push(
      this.session.phone.notifications.on((data) => this.notifications.addNotification(data)),
    )
  }

  // ── webview RPC ─────────────────────────────────────────────────
  private wireRpcHandlers(): void {
    this.ui.handle("chat:get-history", () => this.chatHistory.getMessages())

    this.ui.handle("chat:clear", () => {
      this.chatHistory.clear()
    })

    this.ui.handle("settings:get", () => this.storage.get())

    this.ui.handle("settings:set", async (patch) => {
      const merged = await this.storage.set(patch)
      if (patch.chatHistoryEnabled !== undefined) {
        this.chatHistory.setChatHistoryEnabled(merged.chatHistoryEnabled)
      }
      this.ui.send("settings:update", merged)
      return merged
    })

    this.ui.handle("settings:set-theme", async (theme) => {
      const merged = await this.storage.set({theme})
      this.ui.send("settings:update", merged)
    })

    // Debug: speak a phrase through the glasses and report the device outcome.
    this.ui.handle("debug:speak", async ({text}) => {
      const caps = this.session.capabilities
      const capabilities = {
        modelName: caps?.modelName as string | undefined,
        hasSpeaker: Boolean(caps?.hasSpeaker),
        hasDisplay: Boolean(caps?.hasDisplay),
        hasCamera: Boolean(caps?.hasCamera),
      }
      if (!capabilities.hasSpeaker) {
        return {accepted: false, completed: null, capabilities, error: "Glasses report no speaker"}
      }
      try {
        const result = await this.session.speaker.speak(text, {stopOtherAudio: true})
        return {accepted: true, completed: result?.completed ?? null, capabilities}
      } catch (error) {
        return {
          accepted: false,
          completed: null,
          capabilities,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })
  }

  // ── webview open → hydrate with history snapshot ────────────────
  private wireUILifecycle(): void {
    this.unsubs.push(
      this.ui.onOpen(() => {
        this.emit({type: "history", messages: this.chatHistory.getMessages()})
      }),
    )
  }

  /** Forward a chat event to the webview (no-op if no webview is bound). */
  private emit(event: ChatEvent): void {
    this.ui.send("chat:event", event)
  }

  private dispose(): void {
    this.transcription.destroy()
    this.photo.destroy()
    this.location.destroy()
    this.notifications.destroy()
    this.chatHistory.destroy()
    for (const unsub of this.unsubs) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
    this.unsubs = []
  }
}
