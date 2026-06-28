import { describe, expect, test } from "bun:test";

import type { HttpClient } from "../../http";
import { Feedback } from "./feedback";

function fakeHttp(calls: Array<{ method: string; path: string; body?: unknown }>): HttpClient {
  return {
    get: async () => undefined as never,
    head: async () => new Response(null, { status: 200 }),
    post: async <T>(path: string, body?: unknown): Promise<T> => {
      calls.push({ method: "POST", path, body });
      return { success: true } as T;
    },
    postForm: async () => undefined as never,
    put: async () => undefined as never,
    delete: async () => undefined as never,
    url: (path: string) => `https://core.test${path}`,
  };
}

describe("Core feedback client", () => {
  test("sends non-incident feedback through the client feedback route", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const feedback = new Feedback({ http: fakeHttp(calls) });

    await feedback.send({ feedback: { type: "feature", message: "more buttons" } });

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/client/feedback",
        body: { feedback: { type: "feature", message: "more buttons" } },
      },
    ]);
  });
});
