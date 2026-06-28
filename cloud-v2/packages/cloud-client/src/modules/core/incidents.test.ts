import { describe, expect, test } from "bun:test";

import type { HttpClient } from "../../http";
import { Incidents, type CreateIncidentInput } from "./incidents";

const incidentInput: CreateIncidentInput = {
  trigger: {
    type: "manual",
    surface: "feedback_screen",
    reason: "manual_bug_report",
  },
  report: {
    expectedBehavior: "The app should work.",
    actualBehavior: "The app crashed.",
    userSeverity: 4,
  },
  context: {
    app: { appVersion: "test" },
  },
};

function fakeHttp(calls: Array<{ method: string; path: string; body?: unknown }>): HttpClient {
  return {
    get: async () => undefined as never,
    head: async () => new Response(null, { status: 200 }),
    post: async <T>(path: string, body?: unknown): Promise<T> => {
      calls.push({ method: "POST", path, body });
      if (path === "/api/client/incidents") {
        return { incidentId: "inc_test", status: "collecting", created: true } as T;
      }
      if (path.endsWith("/complete")) {
        return { status: "ready" } as T;
      }
      return { stored: 1 } as T;
    },
    postForm: async <T>(path: string, form: FormData): Promise<T> => {
      calls.push({ method: "POST_FORM", path, body: form });
      return { stored: 1 } as T;
    },
    put: async () => undefined as never,
    delete: async () => undefined as never,
    url: (path: string) => `https://core.test${path}`,
  };
}

describe("Core incidents client", () => {
  test("creates incidents through the Cloud V2 client route", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const incidents = new Incidents({ http: fakeHttp(calls) });

    const result = await incidents.create(incidentInput);

    expect(result).toEqual({ incidentId: "inc_test", status: "collecting", created: true });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/client/incidents",
        body: incidentInput,
      },
    ]);
  });

  test("adds phone logs as typed artifacts", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const incidents = new Incidents({ http: fakeHttp(calls) });

    await incidents.addLogs("inc_123", "phone", [{ timestamp: 1, level: "info", message: "hello" }]);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/client/incidents/inc_123/artifacts",
        body: {
          type: "logs",
          source: "phone",
          entries: [{ timestamp: 1, level: "info", message: "hello" }],
        },
      },
    ]);
  });

  test("adds screenshots as multipart artifacts", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const incidents = new Incidents({ http: fakeHttp(calls) });

    const result = await incidents.addScreenshots("inc_123", [
      { blob: new Blob(["image"], { type: "image/jpeg" }), fileName: "screen.jpg", mimeType: "image/jpeg" },
    ]);

    expect(result).toEqual({ stored: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST_FORM");
    expect(calls[0].path).toBe("/api/client/incidents/inc_123/artifacts");
    expect(calls[0].body).toBeInstanceOf(FormData);
  });

  test("marks incidents ready after artifact collection", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const incidents = new Incidents({ http: fakeHttp(calls) });

    await expect(incidents.complete("inc_123")).resolves.toEqual({ status: "ready" });

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/client/incidents/inc_123/complete",
        body: {},
      },
    ]);
  });

});
