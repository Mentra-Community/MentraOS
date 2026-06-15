/**
 * ChatHistoryManager - In-memory conversation history
 *
 * Features:
 * - In-memory storage of recent conversation turns
 * - Photo data URLs stored alongside turns for frontend sync
 * - Configurable history window
 *
 * Note: MongoDB persistence is disabled for MVP. All data is in-memory only.
 */

import type { User } from "../session/User";
import { CONVERSATION_SETTINGS } from "../constants/config";

/**
 * A conversation turn for context
 */
export interface ConversationTurn {
  query: string;
  response: string;
  timestamp: Date;
  hadPhoto: boolean;
  photoDataUrl?: string;
}

/**
 * ChatHistoryManager — manages conversation history for a single user.
 * In-memory only for MVP — data survives page refresh but not server restart.
 */
export class ChatHistoryManager {
  // In-memory store of recent turns
  private recentTurns: ConversationTurn[] = [];

  constructor(private user: User) {}

  /**
   * Initialize the manager (no-op for in-memory only)
   */
  async initialize(): Promise<void> {
    // No DB operations for MVP
  }

  /**
   * Add a conversation turn
   */
  async addTurn(query: string, response: string, hadPhoto: boolean = false, photoDataUrl?: string): Promise<void> {
    const turn: ConversationTurn = {
      query,
      response,
      timestamp: new Date(),
      hadPhoto,
      photoDataUrl,
    };

    this.recentTurns.push(turn);

    // Trim to max turns
    if (this.recentTurns.length > CONVERSATION_SETTINGS.maxTurns) {
      this.recentTurns = this.recentTurns.slice(-CONVERSATION_SETTINGS.maxTurns);
    }
  }

  /**
   * Get recent turns for context
   * Filters by age and returns up to maxTurns
   */
  getRecentTurns(limit?: number): ConversationTurn[] {
    const now = Date.now();
    const maxAge = CONVERSATION_SETTINGS.maxAgeMs;
    const maxTurns = limit ?? CONVERSATION_SETTINGS.maxTurns;

    // Filter by age
    const recent = this.recentTurns.filter(turn => {
      const age = now - turn.timestamp.getTime();
      return age < maxAge;
    });

    // Return most recent
    return recent.slice(-maxTurns);
  }

  /**
   * Format conversation history for the prompt
   */
  formatForPrompt(limit?: number): string {
    const turns = this.getRecentTurns(limit);

    if (turns.length === 0) {
      return "";
    }

    const formatted = turns.map(turn => {
      const photoNote = turn.hadPhoto ? " (with photo)" : "";
      return `User${photoNote}: ${turn.query}\nAssistant: ${turn.response}`;
    }).join("\n\n");

    return `## Previous Conversation\n\n${formatted}`;
  }

  /**
   * Get conversation history by date (stub — returns empty for MVP)
   */
  async getHistoryByDate(_date: Date): Promise<ConversationTurn[]> {
    return [];
  }

  /**
   * Clear today's conversation
   */
  async clearToday(): Promise<void> {
    this.recentTurns = [];
  }

  /**
   * Clear all conversation history
   */
  async clearAll(): Promise<void> {
    this.recentTurns = [];
  }

  /**
   * Update chat history enabled setting (in-memory flag only)
   */
  async setChatHistoryEnabled(_enabled: boolean): Promise<void> {
    // No-op for MVP — always in-memory
  }

  /**
   * Check if chat history is enabled
   */
  isChatHistoryEnabled(): boolean {
    return false;
  }

  /**
   * Clean up (called on session end)
   */
  destroy(): void {
    this.recentTurns = [];
  }
}
