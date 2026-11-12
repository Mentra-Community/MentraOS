import { describe, expect, mock, test } from "bun:test";
import { createInteractionApi } from "./interaction-api";

const ORIGIN = "https://account.example";

function respond(status: number, body: unknown) {
  return mock(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

describe("calls to Core's sign-in server", () => {
  test("the hand-off posts the access token same-origin and follows only the provider's continuation (Review Focus 1)", async () => {
    const fetchImpl = respond(200, { redirectTo: `${ORIGIN}/oidc/auth/resume-1` });
    const api = createInteractionApi(ORIGIN, fetchImpl);
    expect(await api.handOff("uid-1234567890", "token")).toEqual({ kind: "continue", url: `${ORIGIN}/oidc/auth/resume-1` });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/interaction/uid-1234567890/supabase");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(init!.body as string)).toEqual({ access_token: "token" });
  });

  test.each([
    "https://evil.example/oidc/auth/x",
    "//evil.example/oidc/auth/x",
    "/\\evil.example",
    "javascript:alert(1)",
    `${ORIGIN}/somewhere-else`,
    "/oidc/token",
    "",
  ])("a continuation of %p is never followed", async (redirectTo) => {
    const api = createInteractionApi(ORIGIN, respond(200, { redirectTo }));
    expect(await api.handOff("uid-1234567890", "token")).toEqual({ kind: "error" });
  });

  test("maps Core's answers to fixed states", async () => {
    const cases: Array<[number, "refused" | "expired" | "rate-limited" | "error"]> = [
      [401, "refused"],
      [400, "expired"],
      [429, "rate-limited"],
      [503, "error"],
      [403, "error"],
    ];
    for (const [status, kind] of cases) {
      expect((await createInteractionApi(ORIGIN, respond(status, { error: "x" })).handOff("uid-1234567890", "t")).kind).toBe(kind);
    }
    const offline = mock(async () => {
      throw new TypeError("offline");
    });
    expect(await createInteractionApi(ORIGIN, offline).handOff("uid-1234567890", "t")).toEqual({ kind: "error" });
  });

  test("details: the prompt, the client's name, the scopes, where it returns to and whose data it reaches", async () => {
    const api = createInteractionApi(
      ORIGIN,
      respond(200, {
        prompt: "consent",
        client: { name: "Notes", packageName: "com.mentra.notes" },
        redirectUri: "https://notes.example/callback",
        scopes: ["openid", 3],
      }),
    );
    expect(await api.details("uid-1234567890")).toEqual({
      kind: "ok",
      prompt: "consent",
      clientName: "Notes",
      scopes: ["openid"],
      redirectUri: "https://notes.example/callback",
      packageName: "com.mentra.notes",
    });
    // A Core that sends neither, or sends something else in their place, names no address and no miniapp.
    const bare = createInteractionApi(ORIGIN, respond(200, { prompt: "consent", client: { name: "Notes", packageName: 7 }, redirectUri: ["x"], scopes: [] }));
    expect(await bare.details("uid-1234567890")).toMatchObject({ redirectUri: "", packageName: null });
    expect(await createInteractionApi(ORIGIN, respond(400, {})).details("uid-1234567890")).toEqual({ kind: "expired" });
  });

  test("the consent decision posts allow or deny", async () => {
    const fetchImpl = respond(200, { redirectTo: "/oidc/auth/resume-2" });
    expect(await createInteractionApi(ORIGIN, fetchImpl).decide("uid-1234567890", "deny")).toEqual({
      kind: "continue",
      url: `${ORIGIN}/oidc/auth/resume-2`,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe("/interaction/uid-1234567890/consent");
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({ decision: "deny" });
  });
});
