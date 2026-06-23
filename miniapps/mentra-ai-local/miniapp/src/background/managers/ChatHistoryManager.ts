/**
 * ChatHistoryManager — in-memory conversation history (single user).
 *
 * Holds recent turns for agent context and for hydrating the webview. The
 * cloud app kept this in-memory too (MongoDB was disabled for MVP); here it's
 * the only store. `chatHistoryEnabled` gates whether prior turns are fed back
 * to the agent as context — the on-screen transcript is always kept.
 */

import {CONVERSATION_SETTINGS} from "../constants/config"
import type {ChatMessage} from "../../shared/types"

/** A conversation turn for context. */
export interface ConversationTurn {
  query: string
  response: string
  timestamp: Date
  hadPhoto: boolean
  photoDataUrl?: string
}

export class ChatHistoryManager {
  private recentTurns: ConversationTurn[] = []
  private historyEnabled = false

  /** Add a conversation turn. */
  addTurn(query: string, response: string, hadPhoto = false, photoDataUrl?: string): void {
    this.recentTurns.push({
      query,
      response,
      timestamp: new Date(),
      hadPhoto,
      photoDataUrl,
    })

    if (this.recentTurns.length > CONVERSATION_SETTINGS.maxTurns) {
      this.recentTurns = this.recentTurns.slice(-CONVERSATION_SETTINGS.maxTurns)
    }
  }

  /**
   * Recent turns for agent context. Returns [] when history is disabled so the
   * agent treats each query independently. Filters by age and caps at maxTurns.
   */
  getRecentTurns(limit?: number): ConversationTurn[] {
    if (!this.historyEnabled) return []

    const now = Date.now()
    const maxAge = CONVERSATION_SETTINGS.maxAgeMs
    const maxTurns = limit ?? CONVERSATION_SETTINGS.maxTurns

    const recent = this.recentTurns.filter((turn) => now - turn.timestamp.getTime() < maxAge)
    return recent.slice(-maxTurns)
  }

  /**
   * Full transcript as ChatMessages (user + assistant), for hydrating a
   * freshly-opened webview. Independent of `historyEnabled` — the visible
   * transcript always reflects what happened this session.
   */
  getMessages(): ChatMessage[] {
    const messages: ChatMessage[] = []
    for (let i = 0; i < this.recentTurns.length; i++) {
      const turn = this.recentTurns[i]
      const ts = turn.timestamp.toISOString()
      messages.push({
        id: `user-${i}-${turn.timestamp.getTime()}`,
        senderId: "user",
        content: turn.query,
        timestamp: ts,
        image: turn.photoDataUrl,
      })
      messages.push({
        id: `ai-${i}-${turn.timestamp.getTime()}`,
        senderId: "mentra-ai",
        content: turn.response,
        timestamp: ts,
      })
    }
    return messages
  }

  setChatHistoryEnabled(enabled: boolean): void {
    this.historyEnabled = enabled
  }

  isChatHistoryEnabled(): boolean {
    return this.historyEnabled
  }

  clear(): void {
    this.recentTurns = []
  }

  destroy(): void {
    this.recentTurns = []
  }
}
