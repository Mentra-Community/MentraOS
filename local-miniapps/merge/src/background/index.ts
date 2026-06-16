import {registerMiniapp} from "@mentra/miniapp/background"
import type {CloudClientStatus, MiniappSession, TranscriptionData, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {MergeSnapshot, MergeTranscript} from "../shared/types"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void
type On = <C extends keyof Channels & string>(channel: C, cb: (payload: Channels[C]) => void) => () => void

class MergeController {
  private readonly unsubs: Array<() => void> = []
  private transcriptionCleanup: UnsubscribeFn | null = null
  private transcripts: MergeTranscript[] = []
  private finalCount = 0
  private interimCount = 0
  private cloudStatus: CloudClientStatus = {status: "disconnected", audioTransport: "none"}

  private ui!: {
    send: Send
    on: On
    onOpen: (cb: () => void) => () => void
  }

  constructor(private readonly session: MiniappSession) {}

  start(): void {
    this.ui = this.session.ui as unknown as {
      send: Send
      on: On
      onOpen: (cb: () => void) => () => void
    }

    this.unsubs.push(
      this.ui.onOpen(() => {
        this.sendSnapshot()
      }),
    )
    this.unsubs.push(
      this.ui.on("merge:request-snapshot", () => {
        this.sendSnapshot()
      }),
    )
    this.unsubs.push(
      this.ui.on("merge:clear", () => {
        this.transcripts = []
        this.finalCount = 0
        this.interimCount = 0
        this.sendSnapshot()
      }),
    )

    try {
      this.unsubs.push(
        this.session.cloud.onStatusChanged((status) => {
          this.cloudStatus = {...status}
          this.ui.send("merge:cloud-status", {...this.cloudStatus})
        }),
      )
    } catch (err) {
      console.log("LocalMerge: cloud status subscribe failed", err)
    }

    this.transcriptionCleanup = this.session.transcription.on((data) => {
      this.handleTranscription(data)
    })

    console.log("LocalMerge: started transcription:auto subscriber")
  }

  stop(): void {
    if (this.transcriptionCleanup) {
      this.transcriptionCleanup()
      this.transcriptionCleanup = null
    }
    for (const unsub of this.unsubs) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
    this.unsubs.length = 0
  }

  private handleTranscription(data: TranscriptionData): void {
    if (data.isFinal) this.finalCount += 1
    else this.interimCount += 1

    const entry: MergeTranscript = {
      id: (data as {utteranceId?: string}).utteranceId ?? `merge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      utteranceId: (data as {utteranceId?: string}).utteranceId ?? null,
      text: data.text,
      language: data.language ?? null,
      speakerId: (data as {speakerId?: string}).speakerId ?? null,
      isFinal: data.isFinal,
      receivedAt: Date.now(),
    }

    if (entry.utteranceId) {
      const existing = this.transcripts.findIndex((t) => t.utteranceId === entry.utteranceId)
      if (existing >= 0) this.transcripts[existing] = entry
      else this.transcripts.push(entry)
    } else if (entry.isFinal) {
      this.transcripts = this.transcripts.filter((t) => t.isFinal)
      this.transcripts.push(entry)
    } else {
      this.transcripts = [...this.transcripts.filter((t) => t.isFinal), entry]
    }

    if (this.transcripts.length > 30) this.transcripts = this.transcripts.slice(-30)
    this.ui.send("merge:transcript", entry)
    console.log(
      `LocalMerge: transcript final=${entry.isFinal} lang=${entry.language ?? "unknown"} id=${entry.utteranceId ?? "none"} text="${entry.text}"`,
    )
  }

  private sendSnapshot(): void {
    const snapshot: MergeSnapshot = {
      transcripts: [...this.transcripts],
      finalCount: this.finalCount,
      interimCount: this.interimCount,
      cloudStatus: {...this.cloudStatus},
    }
    this.ui.send("merge:snapshot", snapshot)
  }
}

registerMiniapp((session) => {
  const controller = new MergeController(session)
  controller.start()
  session.onBeforeDisconnect(() => {
    controller.stop()
  })
})
