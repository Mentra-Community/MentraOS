import { expect, test } from "bun:test";
import { loginHref, returningFromSignIn, sendToSignIn, signOut, signOutOfEnterprisePortal } from "./session";

const SIGN_OUT_URL =
  "https://account.test/oidc/session/end?client_id=workspace-portal&post_logout_redirect_uri=https%3A%2F%2Fportal.test%2F";

test("the login gate starts sign-in with a relative return path", () => {
  expect(loginHref({ pathname: "/workspaces", search: "?ws=ws_1" })).toBe(
    "/api/portal/auth/login?return_to=%2Fworkspaces%3Fws%3Dws_1",
  );
  expect(loginHref({ pathname: "/", search: "?report=rep_1" })).toBe("/api/portal/auth/login?return_to=%2F%3Freport%3Drep_1");
});

test("at the bare address, a pending invitation makes sign-in return to the invitation", () => {
  // Where a full sign-out (Switch account) lands: signing in with the other account comes back to the invitation.
  expect(loginHref({ pathname: "/", search: "" }, true)).toBe("/api/portal/auth/login?return_to=%2Finvitation");
  expect(loginHref({ pathname: "/", search: "" }, false)).toBe("/api/portal/auth/login?return_to=%2F");
  // Any other address keeps its own return path.
  expect(loginHref({ pathname: "/invitation", search: "" }, true)).toBe("/api/portal/auth/login?return_to=%2Finvitation");
  expect(loginHref({ pathname: "/members", search: "?workspace=ws_1" }, true)).toBe(
    "/api/portal/auth/login?return_to=%2Fmembers%3Fworkspace%3Dws_1",
  );
  expect(loginHref({ pathname: "/", search: "?buy=mentra.call" }, true)).toBe("/api/portal/auth/login?return_to=%2F%3Fbuy%3Dmentra.call");
});

test("sign out POSTs the workspace portal logout and returns the Mentra sign-out URL", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const fetchMock = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    return Response.json({ signOutUrl: SIGN_OUT_URL });
  }) as unknown as typeof fetch;
  expect(await signOutOfEnterprisePortal(fetchMock)).toEqual({ signOutUrl: SIGN_OUT_URL });
  expect(calls).toEqual([{ url: "/api/portal/auth/logout", method: "POST" }]);
});

test("a null, unsafe or failed sign-out URL is not followed", async () => {
  const answer = (body: unknown, status = 200) =>
    (async () => Response.json(body, { status })) as unknown as typeof fetch;
  expect(await signOutOfEnterprisePortal(answer({ signOutUrl: null }))).toEqual({ signOutUrl: null });
  expect(await signOutOfEnterprisePortal(answer({ signOutUrl: "javascript:alert(1)" }))).toEqual({ signOutUrl: null });
  expect(await signOutOfEnterprisePortal(answer({}, 503))).toEqual({ signOutUrl: null });
  expect(await signOutOfEnterprisePortal((async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toEqual({ signOutUrl: null });
});

test("signing out goes straight to Core's sign-out URL, replacing this page", async () => {
  const left: string[] = [];
  const fetchMock = (async () => Response.json({ signOutUrl: SIGN_OUT_URL })) as unknown as typeof fetch;
  expect(await signOut({ fetchImpl: fetchMock, leave: url => left.push(url) })).toBe("leaving");
  expect(left).toEqual([SIGN_OUT_URL]);
});

test("without a sign-out URL, or when the call fails, the portal stays and shows its own signed-out screen", async () => {
  const left: string[] = [];
  const leave = (url: string) => left.push(url);
  const answer = (body: unknown, status = 200) =>
    (async () => Response.json(body, { status })) as unknown as typeof fetch;
  expect(await signOut({ fetchImpl: answer({ signOutUrl: null }), leave })).toBe("signed-out");
  expect(await signOut({ fetchImpl: answer({ signOutUrl: "javascript:alert(1)" }), leave })).toBe("signed-out");
  expect(await signOut({ fetchImpl: answer({}, 503), leave })).toBe("signed-out");
  expect(await signOut({ fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, leave })).toBe("signed-out");
  expect(left).toEqual([]);
});

/** A session storage of its own, or one that refuses to be written (a full or locked store). */
function memoryStorage({ refuseWrites = false } = {}): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: key => items.get(key) ?? null,
    key: index => [...items.keys()][index] ?? null,
    removeItem: key => void items.delete(key),
    setItem: (key, value) => {
      if (refuseWrites) throw new Error("QuotaExceededError");
      items.set(key, value);
    },
  };
}

test("a signed-out page goes straight to sign-in, noting it in the tab first", () => {
  const storage = memoryStorage();
  const went: string[] = [];
  expect(sendToSignIn("/api/portal/auth/login?return_to=%2Flicenses", storage, { now: 1_000, go: url => went.push(url) })).toBe(true);
  expect(went).toEqual(["/api/portal/auth/login?return_to=%2Flicenses"]);
  // Back within the minute, still signed out: the page offers the button instead of going again.
  expect(returningFromSignIn(storage, 1_000 + 59_000)).toBe(true);
  // The note is read once: the next page load goes again.
  expect(returningFromSignIn(storage, 1_000 + 59_500)).toBe(false);
});

test("a note older than the round trip, or none, is not a return", () => {
  const storage = memoryStorage();
  expect(returningFromSignIn(storage, 5_000)).toBe(false);
  sendToSignIn("/api/portal/auth/login?return_to=%2F", storage, { now: 1_000, go: () => {} });
  expect(returningFromSignIn(storage, 1_000 + 60_000)).toBe(false);
});

test("without a session storage it neither goes nor counts a return, so it can never loop", () => {
  const went: string[] = [];
  expect(sendToSignIn("/api/portal/auth/login?return_to=%2F", null, { go: url => went.push(url) })).toBe(false);
  expect(sendToSignIn("/api/portal/auth/login?return_to=%2F", memoryStorage({ refuseWrites: true }), { go: url => went.push(url) })).toBe(false);
  expect(went).toEqual([]);
  expect(returningFromSignIn(null)).toBe(true);
});
