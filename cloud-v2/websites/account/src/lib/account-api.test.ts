import { describe, expect, mock, test } from "bun:test";
import { createAccountApi } from "./account-api";

function respond(status: number, body: unknown) {
  return mock(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

describe("password reset through Core's account API", () => {
  test("requests a code, then resets with signIn false so the page never holds a phone session", async () => {
    const fetchImpl = respond(202, { status: "verification_sent" });
    const api = createAccountApi(fetchImpl);
    expect(await api.requestReset("a@example.com")).toEqual({ kind: "ok" });
    expect(await api.resetPassword({ email: "a@example.com", code: "123456", newPassword: "new password" })).toEqual({ kind: "ok" });
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, JSON.parse(init!.body as string)])).toEqual([
      ["/api/account/password/forgot", { email: "a@example.com" }],
      ["/api/account/password/reset", { email: "a@example.com", code: "123456", newPassword: "new password", signIn: false }],
    ]);
  });

  test("maps Core's errors to fixed results", async () => {
    const reset = (status: number, error: string) =>
      createAccountApi(respond(status, { error })).resetPassword({ email: "a@example.com", code: "1", newPassword: "p" });
    expect(await reset(400, "code_invalid")).toEqual({ kind: "invalid-code" });
    expect(await reset(400, "weak_password")).toEqual({ kind: "weak-password" });
    expect(await reset(429, "rate_limited")).toEqual({ kind: "rate-limited" });
    expect(await reset(502, "server_error")).toEqual({ kind: "error" });
  });
});
