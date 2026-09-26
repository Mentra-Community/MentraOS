import { describe, expect, test } from "bun:test";

import type { HttpClient } from "../../http";
import { Reports, type SubmitReportInput } from "./reports";

const bugReportInput: SubmitReportInput = {
  kind: "bug",
  trigger: {
    type: "manual",
    source: "feedback_screen",
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
      if (path === "/api/client/reports") {
        return { reportId: "rep_test", status: "collecting" } as T;
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

describe("Core reports client", () => {
  test("submits bug reports through the Cloud V2 reports route", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const reports = new Reports({ http: fakeHttp(calls) });

    const result = await reports.submit(bugReportInput);

    expect(result).toEqual({ reportId: "rep_test", status: "collecting" });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/client/reports",
        body: bugReportInput,
      },
    ]);
  });

  test("submits feature feedback as the same reporting primitive", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const reports = new Reports({ http: fakeHttp(calls) });

    await reports.submit({
      kind: "feedback",
      feedback: { type: "feature", message: "more buttons" },
      context: { glasses: { model: "test" } },
    });

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/client/reports",
        body: {
          kind: "feedback",
          feedback: { type: "feature", message: "more buttons" },
          context: { glasses: { model: "test" } },
        },
      },
    ]);
  });

  test("adds phone logs as typed artifacts", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const reports = new Reports({ http: fakeHttp(calls) });

    await reports.addLogs("rep_123", "phone", [{ timestamp: 1, level: "info", message: "hello" }]);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/client/reports/rep_123/artifacts",
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
    const reports = new Reports({ http: fakeHttp(calls) });

    const result = await reports.addScreenshots("rep_123", [
      { blob: new Blob(["image"], { type: "image/jpeg" }), fileName: "screen.jpg", mimeType: "image/jpeg" },
    ]);

    expect(result).toEqual({ stored: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST_FORM");
    expect(calls[0].path).toBe("/api/client/reports/rep_123/artifacts");
    expect(calls[0].body).toBeInstanceOf(FormData);
  });

  test("adds MP4 videos with their declared capture source through the existing artifact route", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const reports = new Reports({ http: fakeHttp(calls) });
    const bytes = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);

    const result = await reports.addVideos("rep_123", "host", [
      { blob: new Blob([bytes]), fileName: "recording.mp4" },
      { blob: new Blob([bytes], { type: "video/mp4" }) },
    ]);

    expect(result).toEqual({ stored: 1 });
    // One artifact call on the existing report; no submit or complete.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST_FORM");
    expect(calls[0].path).toBe("/api/client/reports/rep_123/artifacts");
    const form = calls[0].body as FormData;
    expect(form.get("type")).toBe("video");
    expect(form.get("source")).toBe("host");
    const files = form.getAll("files") as File[];
    expect(files.map((file) => file.type)).toEqual(["video/mp4", "video/mp4"]);
    expect(files[0].name).toBe("recording.mp4");
    expect(files[1].name).toMatch(/^video-\d+\.mp4$/);
    expect(new Uint8Array(await files[0].arrayBuffer())).toEqual(bytes);
  });

  test("rejects a video without a blob or uri before sending anything", () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const reports = new Reports({ http: fakeHttp(calls) });

    expect(() => reports.addVideos("rep_123", "host", [{ fileName: "missing.mp4" }])).toThrow(
      "report video requires either blob or uri",
    );
    expect(calls).toHaveLength(0);
  });

  test("marks reports ready after artifact collection", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const reports = new Reports({ http: fakeHttp(calls) });

    await expect(reports.complete("rep_123")).resolves.toEqual({ status: "ready" });

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/client/reports/rep_123/complete",
        body: {},
      },
    ]);
  });
});
