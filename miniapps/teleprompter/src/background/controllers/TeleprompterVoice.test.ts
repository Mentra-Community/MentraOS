import type {RenderElement, RenderResult, TranscriptionData} from "@mentra/miniapp/background"
import type {PlaybackStatus} from "../../shared/types"
import {describe, expect, test} from "bun:test"
import {TeleprompterController} from "./TeleprompterController"
import {ScriptEngine} from "../core/ScriptEngine"

describe("Japanese AI Scroll", () => {
  test.each([false, true])("recovers a delayed Japanese transcript (final: %s)", (isFinal) => {
    const script =
      "今日は東京を歩いています。明日は大阪に行きます。新しい景色を見るのが楽しみです。日本の文化について話します。最後に皆さんへ感謝を伝えます。これから新しい計画を詳しく説明します。どうぞよろしくお願いします。"
    const controller = new TeleprompterController({} as never)
    const internal = controller as unknown as {
      engine: ScriptEngine
      handleTranscription: (data: TranscriptionData) => void
    }
    internal.engine = new ScriptEngine({numberOfLines: 2})
    internal.engine.setScript(script)
    let status!: PlaybackStatus
    Object.assign(controller, {
      state: "playing",
      voiceActive: true,
      render: async () => 1,
      ui: {
        send: (_channel: string, value: PlaybackStatus) => {
          status = value
        },
      },
    })
    try {
      internal.handleTranscription({text: script.slice(0, 69), isFinal} as TranscriptionData)
      expect(status.progress).toBeGreaterThan(0)
      expect(status.state).toBe("playing")
      internal.handleTranscription({text: isFinal ? script.slice(69) : script, isFinal} as TranscriptionData)
      expect(status.progress).toBe(100)
      expect(status.state).toBe("finished")
    } finally {
      controller.stop()
    }
  })

  test.each([false, true])("scrolls on partial and final transcripts (final: %s)", async (isFinal) => {
    const script = "今日は東京です。明日は大阪です。"
    const sent: RenderElement[][] = []
    let status!: PlaybackStatus
    let transcription!: (data: TranscriptionData) => void
    let unsubscribed = false
    const stored: Record<string, string> = {script, voiceFollow: "true", numberOfLines: "2"}
    const controller = new TeleprompterController({
      capabilities: {hasDisplay: true, hasMicrophone: true, display: {width: 80, height: 100}},
      storage: {
        get: async (key: string) => stored[key],
      },
      ui: {
        send: (channel: string, value: PlaybackStatus) => {
          if (channel === "tp:status") status = value
        },
        on: () => () => {},
        onOpen: () => () => {},
      },
      on: () => () => {},
      onCapabilitiesChange: () => () => {},
      onBeforeDisconnect: () => () => {},
      onVisibilityChange: () => () => {},
      actions: {handle: () => () => {}},
      transcription: {
        on: (callback: (data: TranscriptionData) => void) => {
          transcription = callback
          return () => {
            unsubscribed = true
          }
        },
      },
      display: {
        render: async (elements: RenderElement[]): Promise<RenderResult> => {
          sent.push(elements)
          const text = (elements[0] as Extract<RenderElement, {type: "text"}>).text
          const starts = Array.from({length: Math.ceil(text.length / 3)}, (_, i) => i * 3)
          return {
            status: "displayed",
            textLayout: {
              script: {
                lines: starts
                  .slice(0, 2)
                  .map((start) => ({text: text.slice(start, start + 3), start, end: Math.min(start + 3, text.length)})),
                lineStarts: starts,
                capacity: 2,
                truncated: starts.length > 2,
              },
            },
          }
        },
      },
    } as never)
    const speak = async (text: string) => {
      transcription({text, isFinal} as TranscriptionData)
      await Promise.resolve()
      await Promise.resolve()
    }
    try {
      await controller.start()
      controller.play()
      await speak("今日は")
      expect(status.topLine).toBe(1)
      expect(status.progress).toBeGreaterThan(0)
      expect(status.wordIndex).toBe(0)
      expect(status.totalWords).toBe(1)
      expect((sent.at(-1)![0] as Extract<RenderElement, {type: "text"}>).text).toBe(script.slice(3))
      await speak(isFinal ? "東京です" : "今日は、東京です")
      expect(status.topLine).toBe(2)
      controller.nudge(-1)
      await Promise.resolve()
      expect(status.topLine).toBe(1)
      controller.pause()
      controller.seek(75)
      await Promise.resolve()
      expect(status.progress).toBe(75)
      expect(status.state).toBe("paused")
      const paused = status.progress
      await speak("明日は大阪です")
      expect(status.progress).toBe(paused)
      controller.play()
      await speak("明日は大阪です")
      expect(status.state).toBe("finished")
      expect(status.progress).toBe(100)
      expect(status.topLine).toBe(4)
      expect(unsubscribed).toBe(true)
    } finally {
      controller.stop()
    }
  })

  test("keeps the existing fixed-speed Japanese word timing", async () => {
    let status!: PlaybackStatus
    const controller = new TeleprompterController({} as never)
    const internal = controller as unknown as {
      engine: ScriptEngine
      settings: {wpm: number}
      now: () => number
      onTick: () => void
    }
    internal.engine = new ScriptEngine({numberOfLines: 2})
    internal.engine.setScript("今日は東京です。 明日は大阪です。")
    internal.settings.wpm = 120
    Object.assign(controller, {
      state: "playing",
      timerStartMs: 0,
      timerStartWord: 0,
      ui: {
        send: (_channel: string, value: PlaybackStatus) => {
          status = value
        },
      },
    })
    let time = 499
    internal.now = () => time
    try {
      internal.onTick()
      expect(status.wordIndex).toBe(0)
      time = 500
      internal.onTick()
      expect(status.wordIndex).toBe(1)
      expect(status.totalWords).toBe(2)
      expect(status.state).toBe("playing")
      time = 1000
      internal.onTick()
      expect(status.wordIndex).toBe(2)
      expect(status.state).toBe("finished")
    } finally {
      controller.stop()
    }
  })
})
