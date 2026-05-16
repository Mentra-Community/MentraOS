import { describe, expect, test } from "bun:test";

import {
  getFeedbackReceiptDetails,
  getFeedbackReceiptType,
  queueFeedbackReceipt,
  resolveFeedbackReceiptRecipient,
  shouldSendFeedbackReceipt,
  type FeedbackReceiptSender,
} from "./feedback-receipt.service";

describe("feedback receipt helpers", () => {
  test("uses contactEmail when provided and valid", () => {
    expect(
      resolveFeedbackReceiptRecipient("relay@example.com", {
        type: "bug",
        contactEmail: "  followup@example.com  ",
      }),
    ).toBe("followup@example.com");
  });

  test("falls back to auth email when contactEmail is invalid", () => {
    expect(
      resolveFeedbackReceiptRecipient("user@example.com", {
        type: "feature",
        contactEmail: "not-an-email",
      }),
    ).toBe("user@example.com");
  });

  test("classifies structured and legacy feedback", () => {
    expect(getFeedbackReceiptType({ type: "bug" })).toBe("bug");
    expect(getFeedbackReceiptType({ type: "feature" })).toBe("feature");
    expect(getFeedbackReceiptType("legacy feedback")).toBe("feedback");
  });

  test("skips automatic bug report receipts", () => {
    expect(
      shouldSendFeedbackReceipt({
        type: "bug",
        submissionMode: "AUTOMATIC",
      }),
    ).toBe(false);
  });

  test("queues receipts without awaiting delivery", () => {
    let calls = 0;
    const sender: FeedbackReceiptSender = {
      sendFeedbackReceipt: () => {
        calls += 1;
        return new Promise(() => {});
      },
    };

    queueFeedbackReceipt("user@example.com", { type: "feature" }, { sender });

    expect(calls).toBe(1);
  });

  test("extracts bug report details for echo", () => {
    expect(
      getFeedbackReceiptDetails({
        type: "bug",
        expectedBehavior: "  it should work  ",
        actualBehavior: "it crashed",
        severityRating: 4,
      }),
    ).toEqual({
      expectedBehavior: "it should work",
      actualBehavior: "it crashed",
      severityRating: 4,
    });
  });

  test("extracts feature request details for echo", () => {
    expect(
      getFeedbackReceiptDetails({
        type: "feature",
        feedbackText: "add dark mode",
        experienceRating: 5,
      }),
    ).toEqual({
      feedbackText: "add dark mode",
      experienceRating: 5,
    });
  });

  test("extracts legacy string feedback as echo", () => {
    expect(getFeedbackReceiptDetails("  please fix the thing  ")).toEqual({
      legacyText: "please fix the thing",
    });
  });

  test("returns undefined when no echo content is present", () => {
    expect(getFeedbackReceiptDetails({ type: "bug" })).toBeUndefined();
    expect(getFeedbackReceiptDetails("")).toBeUndefined();
  });

  test("ignores out-of-range ratings", () => {
    expect(
      getFeedbackReceiptDetails({
        type: "feature",
        feedbackText: "hi",
        experienceRating: 12,
      }),
    ).toEqual({ feedbackText: "hi" });
  });

  test("passes echo details through to the sender", async () => {
    let received: { details?: unknown } = {};
    const sender: FeedbackReceiptSender = {
      sendFeedbackReceipt: async (_email, _type, _incidentId, details) => {
        received.details = details;
        return {};
      },
    };

    queueFeedbackReceipt(
      "user@example.com",
      {
        type: "bug",
        expectedBehavior: "should work",
        actualBehavior: "broken",
        severityRating: 3,
      },
      { sender },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received.details).toEqual({
      expectedBehavior: "should work",
      actualBehavior: "broken",
      severityRating: 3,
    });
  });

  test("does not call sender for automatic bug reports", () => {
    let calls = 0;
    const sender: FeedbackReceiptSender = {
      sendFeedbackReceipt: async () => {
        calls += 1;
        return {};
      },
    };

    queueFeedbackReceipt(
      "user@example.com",
      {
        type: "bug",
        submissionMode: "AUTOMATIC",
      },
      { sender },
    );

    expect(calls).toBe(0);
  });
});
