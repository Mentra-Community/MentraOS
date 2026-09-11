/**
 * TeleprompterController — the always-on teleprompter logic for this miniapp.
 *
 * Lives inside the per-miniapp JSContext (NOT the WebView). It survives
 * WebView open/close cycles, so the prompter keeps running on the glasses
 * while the phone is in a pocket.
 *
 * Responsibilities, fused into one controller:
 *   - Settings        — storage-backed, loaded on start, persisted on change.
 *   - Layout          — wraps the script to the connected glasses via ScriptEngine.
 *   - Scroll drivers  — two ways to advance the reading cursor:
 *       • Voice-follow: live transcription is anchored against the script.
 *       • Timed (WPM):  a wall-clock interval advances at a set words/minute.
 *   - Rendering       — pushes the visible window to the glasses (deduped).
 *   - UI bus          — mirrors status to the WebView and takes its commands.
 *
 * Why wall-clock for the timer: iOS freezes JS timers while the app is
 * suspended, then fires a burst on resume. We compute the cursor from
 * elapsed wall-clock time (not a per-tick counter) and dedupe identical
 * display pushes, so a resume jumps straight to the right place instead of
 * flooding the glasses. (See the project's iOS background-pacing notes.)
 */

import type {MiniappSession, TranscriptionData, UnsubscribeFn} from "@mentra/miniapp/background"

import {ScriptEngine, normalizeWords} from "../core/ScriptEngine"
import type {DisplayProfile} from "../core/ScriptEngine"
import {getModelName, getProfileForModel, hasDisplayCapability, hasMicrophoneCapability} from "../core/DisplayProfiles"
import type {Channels} from "../../shared/channels"
import type {LineWidth, PlaybackState, PlaybackStatus, TeleprompterSettings} from "../../shared/types"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void
type On = <C extends keyof Channels & string>(channel: C, cb: (payload: Channels[C]) => void) => () => void

const DEFAULT_SCRIPT = [
  "Welcome to your teleprompter.",
  "",
  "Paste or type your script here, put on your glasses, and press play. The words scroll by on their own at the speed you set, line by line.",
  "",
  "Want it to keep pace with you instead? Turn on AI Scroll and the prompter listens — it advances as you speak, and waits when you pause.",
  "",
  "That's it. Look up, speak naturally, and never lose your place.",
].join("\n")

const DEFAULT_SETTINGS: TeleprompterSettings = {
  script: DEFAULT_SCRIPT,
  wpm: 130,
  numberOfLines: 4,
  lineWidth: 2,
  // Default to timed auto-scroll: pressing Play advances the script on its own.
  // Voice-follow ("AI Scroll") is an explicit opt-in via the cockpit toggle —
  // otherwise Play silently waits for speech and reads as "it doesn't work".
  voiceFollow: false,
  autoRestart: false,
  showTimecode: false,
}

const STORAGE_KEYS = {
  script: "script",
  wpm: "wpm",
  numberOfLines: "numberOfLines",
  lineWidth: "lineWidth",
  voiceFollow: "voiceFollow",
  autoRestart: "autoRestart",
  showTimecode: "showTimecode",
} as const

const WPM_MIN = 30
const WPM_MAX = 400
const TICK_MS = 350
/** How many trailing spoken words we anchor against the script. */
const PROBE_WORDS = 6
/** Rolling cap on remembered spoken words. */
const SPOKEN_HISTORY = 16

/**
 * Preserve blank viewport rows without emitting consecutive newlines. Even
 * Realities G2 shuts down its EvenHub page when a text container contains an
 * interior empty line (`\n\n`), leaving the display blank until that row
 * scrolls away. A zero-width space survives the host's line trimming and
 * renders as the same blank row without tripping the firmware parser.
 */
export function serializeDisplayLines(lines: string[]): string {
  return lines.map((line) => (line === "" ? "\u200B" : line)).join("\n")
}

export class TeleprompterController {
  private started = false
  private readonly unsubs: Array<() => void> = []

  private ui!: {send: Send; on: On; onOpen: (cb: () => void) => () => void}

  private settings: TeleprompterSettings = {...DEFAULT_SETTINGS}
  private engine!: ScriptEngine
  private profile!: DisplayProfile
  private hasDisplay = false
  private hasMic = true

  // ── Playback state ─────────────────────────────────────────────────────
  private state: PlaybackState = "idle"
  private cursor = 0
  private currentTopLine = 0
  private currentVisible: string[] = []
  private lastRenderedText = ""

  // WPM timer
  private timer: ReturnType<typeof setInterval> | null = null
  private timerStartMs = 0
  private timerStartWord = 0

  // Voice-follow
  private transcriptionCleanup: UnsubscribeFn | null = null
  private voiceActive = false
  private recentSpoken: string[] = []

  constructor(private readonly session: MiniappSession) {}

  // ───────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.ui = this.session.ui as unknown as {
      send: Send
      on: On
      onOpen: (cb: () => void) => () => void
    }

    this.profile = getProfileForModel(getModelName(this.session))
    this.hasDisplay = hasDisplayCapability(this.session)
    this.hasMic = hasMicrophoneCapability(this.session)

    await this.loadSettings()

    this.engine = new ScriptEngine({
      profile: this.profile,
      widthSetting: this.settings.lineWidth,
      numberOfLines: this.settings.numberOfLines,
    })
    this.engine.setScript(this.settings.script)
    this.applyViewport()

    // React to glasses model / display changes.
    try {
      this.unsubs.push(this.session.onCapabilitiesChange(() => this.onCapabilitiesChanged()))
    } catch {
      /* capabilities-change not available — keep current profile */
    }

    // CONNECT_ACK populates session.capabilities but only emits "ready" (not a
    // "capabilities" event), so the model/display we read above is null until
    // the phone responds. Re-evaluate once the session is ready, and cover the
    // case where it was already ready by the time start() ran.
    try {
      this.unsubs.push(this.session.on("ready", () => this.onCapabilitiesChanged()))
    } catch {
      /* on() not available in this runtime — ignore */
    }
    if (this.session.ready) {
      this.profile = getProfileForModel(getModelName(this.session))
      this.hasDisplay = hasDisplayCapability(this.session)
      this.hasMic = hasMicrophoneCapability(this.session)
      this.engine.setLayout({profile: this.profile})
      this.applyViewport()
    }

    // Tear down playback drivers when the session ends (app disabled / glasses
    // disconnected) so the WPM timer and mic subscription don't outlive the
    // session. onBeforeDisconnect fires just before the transport closes.
    try {
      this.unsubs.push(this.session.onBeforeDisconnect(() => this.stop()))
    } catch {
      /* before-disconnect hook not available in this runtime — ignore */
    }

    // When the miniapp returns to the foreground it must reclaim the main view —
    // another app or a system screen may have overwritten it while we were
    // backgrounded. Force the next render to push by clearing the dedupe cache.
    try {
      this.unsubs.push(
        this.session.onVisibilityChange((v) => {
          if (v === "foreground") {
            this.lastRenderedText = ""
            this.render()
            this.broadcastStatus()
          }
        }),
      )
    } catch {
      /* visibility events not available in this runtime — ignore */
    }

    this.registerUiHandlers()
    this.registerActions()

    // Show the opening lines as a ready-to-read preview on the glasses.
    this.render()
    this.broadcastStatus()
    console.log(
      `Teleprompter: started (words=${this.engine.totalWords}, lines=${this.engine.totalLines}, profile=${this.profile.id})`,
    )
  }

  stop(): void {
    this.clearTimer()
    this.unsubscribeTranscription()
    for (const u of this.unsubs) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.unsubs.length = 0
    this.started = false
  }

  // ───────────────────────────────────────────────────────────────────────
  // UI bus
  // ───────────────────────────────────────────────────────────────────────

  private registerUiHandlers(): void {
    this.unsubs.push(this.ui.onOpen(() => this.sendSnapshot()))
    this.unsubs.push(this.ui.on("tp:request-snapshot", () => this.sendSnapshot()))

    this.unsubs.push(this.ui.on("tp:set-script", ({script}) => void this.setScript(script)))
    this.unsubs.push(this.ui.on("tp:set-wpm", ({wpm}) => void this.setWpm(wpm)))
    this.unsubs.push(this.ui.on("tp:set-lines", ({lines}) => void this.setLines(lines)))
    this.unsubs.push(this.ui.on("tp:set-width", ({width}) => void this.setWidth(width)))
    this.unsubs.push(this.ui.on("tp:set-voice-follow", ({enabled}) => void this.setVoiceFollow(enabled)))
    this.unsubs.push(this.ui.on("tp:set-auto-restart", ({enabled}) => void this.setAutoRestart(enabled)))
    this.unsubs.push(this.ui.on("tp:set-show-timecode", ({enabled}) => void this.setShowTimecode(enabled)))

    this.unsubs.push(this.ui.on("tp:play", () => this.play()))
    this.unsubs.push(this.ui.on("tp:pause", () => this.pause()))
    this.unsubs.push(this.ui.on("tp:restart", () => this.restart()))
    this.unsubs.push(this.ui.on("tp:seek", ({percent}) => this.seek(percent)))
    this.unsubs.push(this.ui.on("tp:nudge", ({lines}) => this.nudge(lines)))
  }

  // ───────────────────────────────────────────────────────────────────────
  // Actions (cross-miniapp / AI)
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Declared in miniapp.json. A system miniapp (e.g. Mentra AI) invokes this to
   * "open the teleprompter with this text" — the host headless-wakes us if we're
   * stopped, then delivers the call once start() registers the handler. We load
   * the script and render it to the glasses; the caller gets back a small
   * summary so the AI can confirm what landed.
   */
  private registerActions(): void {
    try {
      this.unsubs.push(
        this.session.actions.handle("load_script", (params) => {
          // `script` is required and must be a string. Reject malformed calls
          // here (the handler is the last line of defense for action params) —
          // coercing a missing/non-string value to "" would wipe the user's
          // saved script. The thrown error is returned to the caller.
          if (typeof params.script !== "string") {
            throw new Error("load_script: 'script' is required and must be a string")
          }
          // Default on: opening the teleprompter with text should start reading.
          const autostart = params.autostart !== false
          return this.loadScript(params.script, autostart)
        }),
      )
    } catch (err) {
      // actions module unavailable on this host, or already registered — the
      // miniapp still runs, it just can't be opened via the action.
      console.log("Teleprompter: failed to register actions", err)
    }
  }

  /**
   * Replace the script and surface it on the glasses, ready to read. Unlike the
   * UI's tp:set-script (which no-ops on an unchanged script to avoid disturbing
   * the editor), this always resets to the top and re-renders — an explicit
   * "open with this text" should land deterministically. Optionally autostarts.
   */
  async loadScript(script: string, autostart: boolean): Promise<{words: number; lines: number; started: boolean}> {
    const next = script ?? ""
    this.settings.script = next
    this.engine.setScript(next)
    // Reset to the top, stop any in-progress read, then show the opening lines.
    this.toIdle()
    // Force the push even if the opening window matches what we last sent:
    // another app may have overwritten the glasses while we were backgrounded,
    // so an explicit "open with this text" must land on-screen rather than be
    // deduped away by render()'s lastRenderedText cache.
    this.lastRenderedText = ""
    this.render()
    this.broadcastSettings()
    this.broadcastStatus()
    await this.persist(STORAGE_KEYS.script, next)

    const started = autostart && this.engine.totalWords > 0
    if (started) this.play()

    return {words: this.engine.totalWords, lines: this.engine.totalLines, started}
  }

  private sendSnapshot(): void {
    this.ui.send("tp:snapshot", {settings: {...this.settings}, status: this.buildStatus()})
  }

  private broadcastStatus(): void {
    this.ui.send("tp:status", this.buildStatus())
  }

  private broadcastSettings(): void {
    this.ui.send("tp:settings-update", {...this.settings})
  }

  // ───────────────────────────────────────────────────────────────────────
  // Transport
  // ───────────────────────────────────────────────────────────────────────

  play(): void {
    if (this.engine.totalWords === 0) return
    if (this.state === "finished" || this.cursor >= this.engine.totalWords) {
      this.cursor = 0
    }
    this.state = "playing"
    this.recentSpoken = []

    if (this.settings.voiceFollow) {
      this.clearTimer()
      this.startVoiceFollow()
    } else {
      this.unsubscribeTranscription()
      this.startTimer()
    }
    this.render()
    this.broadcastStatus()
  }

  pause(): void {
    if (this.state !== "playing") return
    this.state = "paused"
    this.clearTimer()
    this.unsubscribeTranscription()
    this.render()
    this.broadcastStatus()
  }

  restart(): void {
    this.cursor = 0
    this.recentSpoken = []
    if (this.state === "finished") this.state = "paused"
    if (this.state === "playing" && !this.voiceActive) {
      this.timerStartWord = 0
      this.timerStartMs = this.now()
    }
    this.render()
    this.broadcastStatus()
  }

  seek(percent: number): void {
    this.moveCursorTo(this.engine.wordForPercent(percent))
  }

  nudge(lines: number): void {
    const newTop = Math.max(0, Math.min(this.currentTopLine + lines, this.engine.maxTopLine))
    this.moveCursorTo(this.engine.firstWordOfLine(newTop))
  }

  /**
   * Jump the reading cursor to a position (scrub / nudge). If this lands at the
   * end while playing, run the end-of-script handler so auto-restart and the
   * finished state fire — the timer/voice drivers aren't ticking here.
   */
  private moveCursorTo(word: number): void {
    this.cursor = Math.max(0, Math.min(word, this.engine.totalWords))
    this.recentSpoken = []
    if (this.state === "playing" && this.cursor >= this.engine.totalWords) {
      this.handleEnd()
      return
    }
    if (this.state === "finished" && this.cursor < this.engine.totalWords) this.state = "paused"
    if (this.state === "playing" && !this.voiceActive) {
      this.timerStartWord = this.cursor
      this.timerStartMs = this.now()
    }
    this.render()
    this.broadcastStatus()
  }

  // ───────────────────────────────────────────────────────────────────────
  // WPM timer driver
  // ───────────────────────────────────────────────────────────────────────

  private startTimer(): void {
    this.voiceActive = false
    this.timerStartWord = this.cursor
    this.timerStartMs = this.now()
    this.clearTimer()
    this.timer = setInterval(() => this.onTick(), TICK_MS)
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private onTick(): void {
    if (this.state !== "playing" || this.voiceActive) return
    const elapsedSec = (this.now() - this.timerStartMs) / 1000
    const advanced = Math.floor((elapsedSec * this.settings.wpm) / 60)
    const next = Math.min(this.timerStartWord + advanced, this.engine.totalWords)
    if (next !== this.cursor) {
      this.cursor = next
      if (this.cursor >= this.engine.totalWords) {
        this.handleEnd()
        return
      }
      this.render()
    }
    this.broadcastStatus()
  }

  // ───────────────────────────────────────────────────────────────────────
  // Voice-follow driver
  // ───────────────────────────────────────────────────────────────────────

  private startVoiceFollow(): void {
    this.unsubscribeTranscription()
    // `transcription.on` only registers a handler + sends a fire-and-forget
    // subscription — it never throws when the device has no mic. So gate on the
    // device's microphone capability instead and fall back to the timed driver
    // when there's nothing to listen with, rather than silently stalling.
    if (!this.hasMic) {
      console.log("Teleprompter: no microphone on device, using timed scroll")
      this.voiceActive = false
      this.startTimer()
      return
    }
    try {
      this.transcriptionCleanup = this.session.transcription.on((data) => this.handleTranscription(data))
      this.voiceActive = true
    } catch (err) {
      console.log("Teleprompter: voice-follow subscribe failed, using timed scroll", err)
      this.voiceActive = false
      this.startTimer()
    }
  }

  private unsubscribeTranscription(): void {
    if (this.transcriptionCleanup) {
      try {
        this.transcriptionCleanup()
      } catch {
        /* ignore */
      }
      this.transcriptionCleanup = null
    }
    this.voiceActive = false
  }

  private handleTranscription(data: TranscriptionData): void {
    if (this.state !== "playing" || !this.voiceActive) return
    const spoken = normalizeWords(data.text || "")
    if (spoken.length === 0) return

    let probe: string[]
    if (data.isFinal) {
      this.recentSpoken.push(...spoken)
      if (this.recentSpoken.length > SPOKEN_HISTORY) {
        this.recentSpoken = this.recentSpoken.slice(-SPOKEN_HISTORY)
      }
      probe = this.recentSpoken.slice(-PROBE_WORDS)
    } else {
      probe = [...this.recentSpoken, ...spoken].slice(-PROBE_WORDS)
    }

    const next = this.engine.matchSpoken(probe, this.cursor)
    if (next !== this.cursor) {
      this.cursor = next
      if (this.cursor >= this.engine.totalWords) {
        this.handleEnd()
        return
      }
      this.render()
      this.broadcastStatus()
    }
  }

  private handleEnd(): void {
    if (this.settings.autoRestart) {
      this.cursor = 0
      this.recentSpoken = []
      if (!this.voiceActive) {
        this.timerStartWord = 0
        this.timerStartMs = this.now()
      }
      this.render()
      this.broadcastStatus()
      return
    }
    this.state = "finished"
    this.clearTimer()
    this.unsubscribeTranscription()
    this.render()
    this.broadcastStatus()
  }

  // ───────────────────────────────────────────────────────────────────────
  // Settings
  // ───────────────────────────────────────────────────────────────────────

  private async loadSettings(): Promise<void> {
    try {
      const [script, wpm, lines, width, voice, replay, timecode] = await Promise.all([
        this.session.storage.get(STORAGE_KEYS.script),
        this.session.storage.get(STORAGE_KEYS.wpm),
        this.session.storage.get(STORAGE_KEYS.numberOfLines),
        this.session.storage.get(STORAGE_KEYS.lineWidth),
        this.session.storage.get(STORAGE_KEYS.voiceFollow),
        this.session.storage.get(STORAGE_KEYS.autoRestart),
        this.session.storage.get(STORAGE_KEYS.showTimecode),
      ])

      this.settings = {
        script: script ?? DEFAULT_SETTINGS.script,
        wpm: this.clampWpm(this.parseIntOr(wpm, DEFAULT_SETTINGS.wpm)),
        numberOfLines: this.clampLines(this.parseIntOr(lines, DEFAULT_SETTINGS.numberOfLines)),
        lineWidth: this.clampWidth(this.parseIntOr(width, DEFAULT_SETTINGS.lineWidth)),
        voiceFollow: voice == null ? DEFAULT_SETTINGS.voiceFollow : voice === "true",
        autoRestart: replay == null ? DEFAULT_SETTINGS.autoRestart : replay === "true",
        showTimecode: timecode == null ? DEFAULT_SETTINGS.showTimecode : timecode === "true",
      }
    } catch (err) {
      console.log("Teleprompter: failed to load settings, using defaults", err)
      this.settings = {...DEFAULT_SETTINGS}
    }
  }

  private async setScript(text: string): Promise<void> {
    const next = text ?? ""
    // No-op writes (e.g. focusing then blurring the editor) must not disturb
    // an in-progress read.
    if (next === this.settings.script) return
    this.settings.script = next
    // Apply the new script SYNCHRONOUSLY (before any await). A transport command
    // delivered right after tp:set-script — e.g. the UI flushing a pending edit
    // and then sending tp:play — is handled on the next turn of the bus; if we
    // awaited persist first, play() would run against the old script and the
    // toIdle reset would land mid-playback and halt it.
    this.engine.setScript(next)
    // Editing the script resets the read position and stops playback.
    this.toIdle()
    this.render()
    this.broadcastSettings()
    this.broadcastStatus()
    await this.persist(STORAGE_KEYS.script, next)
  }

  private async setWpm(wpm: number): Promise<void> {
    this.settings.wpm = this.clampWpm(wpm)
    await this.persist(STORAGE_KEYS.wpm, String(this.settings.wpm))
    // Apply the new speed from the current position without a jump.
    if (this.state === "playing" && !this.voiceActive) {
      this.timerStartWord = this.cursor
      this.timerStartMs = this.now()
    }
    if (this.settings.showTimecode) this.render()
    this.broadcastSettings()
    this.broadcastStatus()
  }

  private async setLines(lines: number): Promise<void> {
    this.settings.numberOfLines = this.clampLines(lines)
    await this.persist(STORAGE_KEYS.numberOfLines, String(this.settings.numberOfLines))
    this.applyViewport()
    this.render()
    this.broadcastSettings()
    this.broadcastStatus()
  }

  private async setWidth(width: LineWidth): Promise<void> {
    this.settings.lineWidth = this.clampWidth(width)
    await this.persist(STORAGE_KEYS.lineWidth, String(this.settings.lineWidth))
    this.engine.setLayout({widthSetting: this.settings.lineWidth})
    this.render()
    this.broadcastSettings()
    this.broadcastStatus()
  }

  private async setVoiceFollow(enabled: boolean): Promise<void> {
    this.settings.voiceFollow = enabled
    await this.persist(STORAGE_KEYS.voiceFollow, String(enabled))
    // If mid-playback, switch drivers live.
    if (this.state === "playing") {
      this.recentSpoken = []
      if (enabled) {
        this.clearTimer()
        this.startVoiceFollow()
      } else {
        this.unsubscribeTranscription()
        this.startTimer()
      }
    }
    this.broadcastSettings()
    this.broadcastStatus()
  }

  private async setAutoRestart(enabled: boolean): Promise<void> {
    this.settings.autoRestart = enabled
    await this.persist(STORAGE_KEYS.autoRestart, String(enabled))
    this.broadcastSettings()
    this.broadcastStatus()
  }

  private async setShowTimecode(enabled: boolean): Promise<void> {
    this.settings.showTimecode = enabled
    await this.persist(STORAGE_KEYS.showTimecode, String(enabled))
    // The timecode footer occupies a row, so the script viewport shrinks by one
    // when it's on. Re-apply so windowAt builds exactly the rows we display —
    // otherwise a line scrolls past unseen.
    this.applyViewport()
    this.render()
    this.broadcastSettings()
    this.broadcastStatus()
  }

  private async persist(key: string, value: string): Promise<void> {
    try {
      await this.session.storage.set(key, value)
    } catch (err) {
      console.log(`Teleprompter: failed to persist ${key}`, err)
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Capabilities
  // ───────────────────────────────────────────────────────────────────────

  private onCapabilitiesChanged(): void {
    const prevHasMic = this.hasMic
    const newProfile = getProfileForModel(getModelName(this.session))
    this.hasDisplay = hasDisplayCapability(this.session)
    this.hasMic = hasMicrophoneCapability(this.session)
    if (newProfile.id !== this.profile.id) {
      this.profile = newProfile
      this.engine.setLayout({profile: newProfile})
    }
    // maxLines can differ across profiles, so re-derive the viewport (it also
    // accounts for the timecode footer).
    this.applyViewport()

    // Capabilities can arrive after the user already hit play (the first reliable
    // read is on "ready"). If the microphone availability changed while
    // voice-follow is the intended mode, re-select the scroll driver — otherwise
    // voice-follow can stay attached on a mic-less device (and stall) or stay on
    // timed scroll when a mic became available.
    if (this.state === "playing" && this.settings.voiceFollow && this.hasMic !== prevHasMic) {
      this.recentSpoken = []
      this.clearTimer()
      this.startVoiceFollow()
    }

    // Glasses (re)connected or the device changed — the lenses no longer hold
    // our last frame. Clear the dedupe cache so render() force-pushes instead of
    // assuming the current window is still on screen.
    this.lastRenderedText = ""
    this.render()
    this.broadcastStatus()
  }

  // ───────────────────────────────────────────────────────────────────────
  // Rendering
  // ───────────────────────────────────────────────────────────────────────

  private render(): void {
    this.currentTopLine = this.engine.topLineForWord(this.cursor)
    const content = this.engine.windowAt(this.currentTopLine)
    const display = this.composeDisplay(content)
    this.currentVisible = display

    const text = serializeDisplayLines(display)
    // Only mark text as rendered when we actually push it. If we skipped the
    // push because no display was attached yet, leave the cache untouched so
    // the first push after the glasses connect isn't deduped away.
    if (this.hasDisplay && text !== this.lastRenderedText) {
      // One full-canvas text element with a stable id: each scroll step updates
      // it in place on the glasses. Box coordinates are raw device px — read
      // from capabilities, falling back to the largest canvas (the host clamps
      // to the real one). render() never throws.
      const d = this.session.capabilities?.display
      void this.session.display.render([
        {type: "text", id: "script", box: {x: 0, y: 0, w: d?.width ?? 576, h: d?.height ?? 288}, text},
      ])
      this.lastRenderedText = text
    }
  }

  /**
   * Append the timecode footer when enabled. The script viewport already
   * reserves a row for it (see applyViewport), so `content` fits beneath the
   * profile's max-lines without trimming — no script row is dropped unseen.
   */
  private composeDisplay(content: string[]): string[] {
    if (!this.settings.showTimecode) return content
    return [...content, this.timecodeLine()]
  }

  /**
   * Re-derive the on-glasses script viewport from the user's line count, the
   * device's max lines, and whether the timecode footer steals a row. Keeping
   * the engine's window in lockstep with what we actually render means scrolling
   * advances by exactly the rows the reader sees.
   */
  private applyViewport(): void {
    const footer = this.settings.showTimecode ? 1 : 0
    const effective = Math.min(this.settings.numberOfLines, Math.max(2, this.profile.maxLines - footer))
    this.engine.setLayout({numberOfLines: effective})
  }

  private timecodeLine(): string {
    const total = this.engine.totalWords
    const posSec = total > 0 ? (this.cursor / this.settings.wpm) * 60 : 0
    const totalSec = (total / this.settings.wpm) * 60
    return `${fmtClock(posSec)} / ${fmtClock(totalSec)}`
  }

  // ───────────────────────────────────────────────────────────────────────
  // Status
  // ───────────────────────────────────────────────────────────────────────

  private buildStatus(): PlaybackStatus {
    const total = this.engine.totalWords
    const remainingWords = Math.max(0, total - this.cursor)
    return {
      state: this.state,
      // Reflect the ACTIVE driver: while playing this is whether the voice
      // subscription actually attached (false after a no-mic fallback); when
      // idle/paused it's whether this device could voice-follow at all.
      voiceMode: this.state === "playing" ? this.voiceActive : this.settings.voiceFollow && this.hasMic,
      wordIndex: this.cursor,
      totalWords: total,
      topLine: this.currentTopLine,
      totalLines: this.engine.totalLines,
      visibleLines: [...this.currentVisible],
      progress: this.engine.progressForWord(this.cursor),
      estimatedTotalSec: (total / this.settings.wpm) * 60,
      remainingSec: (remainingWords / this.settings.wpm) * 60,
      hasDisplay: this.hasDisplay,
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────

  private toIdle(): void {
    this.state = "idle"
    this.cursor = 0
    this.recentSpoken = []
    this.clearTimer()
    this.unsubscribeTranscription()
  }

  private now(): number {
    return Date.now()
  }

  private parseIntOr(raw: string | null, fallback: number): number {
    if (raw == null) return fallback
    const p = parseInt(raw, 10)
    return Number.isNaN(p) ? fallback : p
  }

  private clampWpm(n: number): number {
    if (Number.isNaN(n)) return DEFAULT_SETTINGS.wpm
    return Math.max(WPM_MIN, Math.min(WPM_MAX, Math.round(n)))
  }

  private clampLines(n: number): number {
    if (Number.isNaN(n)) return DEFAULT_SETTINGS.numberOfLines
    return Math.max(2, Math.min(5, Math.round(n)))
  }

  private clampWidth(n: number): LineWidth {
    if (n <= 0) return 0
    if (n >= 2) return 2
    return 1
  }
}

/** Seconds → m:ss. */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, "0")}`
}
