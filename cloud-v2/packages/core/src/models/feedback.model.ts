/**
 * @fileoverview Non-incident user feedback collection.
 */

import { Schema, model, type InferSchemaType } from "mongoose";

const FeedbackSchema = new Schema(
  {
    feedbackId: { type: String, required: true, unique: true, index: true },
    mentraUserId: { type: String, required: true, index: true },
    feedback: { type: Schema.Types.Mixed, required: true },
    phoneState: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true, collection: "feedback" },
);

FeedbackSchema.index({ mentraUserId: 1, createdAt: -1 });

export type Feedback = InferSchemaType<typeof FeedbackSchema>;
export const FeedbackModel = model("Feedback", FeedbackSchema);
