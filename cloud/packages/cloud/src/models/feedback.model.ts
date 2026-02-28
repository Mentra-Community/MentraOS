/* eslint-disable @typescript-eslint/no-explicit-any */
// cloud/src/models/user-feedback.model.ts
import mongoose, { Schema, Document } from "mongoose";

export interface FeedbackI extends Document {
  email: string;
  feedback: string;
}

const FeedbackSchema = new Schema<FeedbackI>(
  {
    email: {
      type: Schema.Types.String,
      ref: "User",
      required: true,
      index: true,
    },

    feedback: {
      type: Schema.Types.String,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// Index for efficient queries
FeedbackSchema.index({ email: 1 });

export const Feedback =
  mongoose.models.Feedback ||
  mongoose.model<FeedbackI>("Feedback", FeedbackSchema);
