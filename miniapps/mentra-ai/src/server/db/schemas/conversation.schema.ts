/**
 * Conversation Schema
 *
 * Stores conversation history between users and Mentra AI.
 * Conversations are grouped by day for efficient retrieval.
 */

import mongoose, { Schema, Document } from 'mongoose';

/**
 * A single conversation turn (user query + AI response)
 */
export interface IConversationTurn {
  query: string;
  response: string;
  timestamp: Date;
  hadPhoto: boolean;
  photoTimestamp?: number;
}

/**
 * A conversation document (one per user per day)
 */
export interface IConversation extends Document {
  userId: string;
  date: Date;
  turns: IConversationTurn[];
  createdAt: Date;
  updatedAt: Date;
}

const ConversationTurnSchema = new Schema<IConversationTurn>({
  query: { type: String, required: true },
  response: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  hadPhoto: { type: Boolean, default: false },
  photoTimestamp: { type: Number },
});

const ConversationSchema = new Schema<IConversation>({
  userId: { type: String, required: true, index: true },
  date: { type: Date, required: true, index: true },
  turns: [ConversationTurnSchema],
}, { timestamps: true });

// Compound index for efficient per-user, per-day queries
ConversationSchema.index({ userId: 1, date: 1 });

export const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema);
