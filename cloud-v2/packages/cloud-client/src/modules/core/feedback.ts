/**
 * @fileoverview Non-incident feedback API.
 *
 * Feature requests and general comments are user feedback, not diagnostic
 * incidents. Keep this split visible in the client surface so callers do not
 * have to build incident-shaped payloads for non-incident data.
 */

import type { HttpClient } from "../../http";

const FEEDBACK_PATH = "/api/client/feedback";

export interface SendFeedbackInput {
  feedback: string | Record<string, unknown>;
  phoneState?: Record<string, unknown>;
}

export interface SendFeedbackResult {
  success: boolean;
}

export interface FeedbackDeps {
  http: HttpClient;
}

export class Feedback {
  private readonly http: HttpClient;

  constructor(deps: FeedbackDeps) {
    this.http = deps.http;
  }

  send(input: SendFeedbackInput): Promise<SendFeedbackResult> {
    return this.http.post<SendFeedbackResult>(FEEDBACK_PATH, {
      feedback: input.feedback,
      ...(input.phoneState && { phoneState: input.phoneState }),
    });
  }
}
