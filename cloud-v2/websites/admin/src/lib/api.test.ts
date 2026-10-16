import {afterEach, expect, spyOn, test} from "bun:test";
import {api} from "./api";

afterEach(() => { restoreFetch?.(); restoreFetch = undefined; });
let restoreFetch: (() => void) | undefined;

function pendingResponse(bodyOnly = false) {
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_path, options) => {
    const pending = new Promise<never>((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {once: true});
    });
    return bodyOnly ? {ok: true, json: () => pending} as unknown as Response : pending;
  }) as typeof fetch);
  restoreFetch = () => fetchMock.mockRestore();
}

test("API timeout ends both a pending request and a pending response body", async () => {
  for (const bodyOnly of [false, true]) {
    pendingResponse(bodyOnly);
    await expect(api("/history", {timeoutMs: 10})).rejects.toThrow("Request timed out. Please try again.");
    restoreFetch!();
  }
});

test("query cancellation remains cancellation rather than a timeout", async () => {
  pendingResponse();
  const controller = new AbortController();
  const result = api("/history", {signal: controller.signal, timeoutMs: 1000});
  controller.abort(new DOMException("Query cancelled", "AbortError"));
  await expect(result).rejects.toThrow("Query cancelled");
});
