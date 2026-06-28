import { describe, expect, test } from "bun:test";

import type { HttpClient } from "../../http";
import { Incidents, type IncidentBugFeedback } from "./incidents";

const bugFeedback: IncidentBugFeedback = {
  type: "bug",
  expectedBehavior: "The app should work.",
  actualBehavior: "The app crashed.",
  severityRating: 4,
  submissionMode: "USER_INITIATED",
  triggerArea: "feedback_screen",
  triggerReason: "manual_bug_report",
  systemInfo: { appVersion: "test" },
};

function fakeHttp(calls: Array<{ method: string; path: string; body?: unknown }>): HttpClient {
  return {
    get: async () => undefined as never,
    head: async () => new Response(null, { status: 200 }),
    post: async <T>(path: string, body?: unknown): Promise<T> => {
      calls.push({ method: "POST", path, body });
      if (path === "/api/incidents") {
        return { success: true, incidentId: "inc_test" } as T;
      }
      return { success: true } as T;
    },
    postForm: async <T>(path: string, form: FormData): Promise<T> => {
      calls.push({ method: "POST_FORM", path, body: form });
      return { uploaded: 1, errors: 0 } as T;
    },
    put: async () => undefined as never,
    delete: async () => undefined as never,
    url: (path: string) => `https://core.test${path}`,
  };
}

describe("Core incidents client", () => {
  test("creates incidents on the compatibility mount", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const incidents = new Incidents({ http: fakeHttp(calls) });

    const result = await incidents.create(bugFeedback, { app: "state" });

    expect(result).toEqual({ success: true, incidentId: "inc_test" });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/incidents",
        body: { feedback: bugFeedback, phoneState: { app: "state" } },
      },
    ]);
  });

  test("uploads phone logs against an incident id", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const incidents = new Incidents({ http: fakeHttp(calls) });

    await incidents.uploadLogs("inc_123", [{ timestamp: 1, level: "info", message: "hello" }]);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/incidents/inc_123/logs",
        body: {
          source: "phone",
          logs: [{ timestamp: 1, level: "info", message: "hello" }],
        },
      },
    ]);
  });

  test("uploads attachments as multipart form data", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const incidents = new Incidents({ http: fakeHttp(calls) });

    const result = await incidents.uploadAttachments("inc_123", [
      { blob: new Blob(["image"], { type: "image/jpeg" }), fileName: "screen.jpg", mimeType: "image/jpeg" },
    ]);

    expect(result).toEqual({ uploaded: 1, errors: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST_FORM");
    expect(calls[0].path).toBe("/api/incidents/inc_123/attachments");
    expect(calls[0].body).toBeInstanceOf(FormData);
  });

  test("sends non-bug feedback through the client feedback route", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const incidents = new Incidents({ http: fakeHttp(calls) });

    await incidents.sendFeedback({ type: "feature", message: "more buttons" });

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/client/feedback",
        body: { feedback: { type: "feature", message: "more buttons" } },
      },
    ]);
  });
});
