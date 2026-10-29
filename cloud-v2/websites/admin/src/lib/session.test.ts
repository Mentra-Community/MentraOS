import { expect, test } from "bun:test";
import { loginHref, signOut, signOutOfAdminPortal } from "./session";

const SIGN_OUT_URL = "https://account.test/oidc/session/end?client_id=admin-portal&post_logout_redirect_uri=https%3A%2F%2Fadmin.test%2F";

test("the login gate starts sign-in with a relative return path", () => {
  expect(loginHref({ pathname: "/workspaces", search: "?ws=ws_1" })).toBe(
    "/api/admin/auth/login?return_to=%2Fworkspaces%3Fws%3Dws_1",
  );
  expect(loginHref({ pathname: "/", search: "?report=rep_1" })).toBe("/api/admin/auth/login?return_to=%2F%3Freport%3Drep_1");
});

test("sign out POSTs the admin logout and returns the Mentra sign-out URL", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const fetchMock = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    return Response.json({ signOutUrl: SIGN_OUT_URL });
  }) as unknown as typeof fetch;
  expect(await signOutOfAdminPortal(fetchMock)).toEqual({ signOutUrl: SIGN_OUT_URL });
  expect(calls).toEqual([{ url: "/api/admin/auth/logout", method: "POST" }]);
});

test("a null, unsafe or failed sign-out URL is not followed", async () => {
  const answer = (body: unknown, status = 200) =>
    (async () => Response.json(body, { status })) as unknown as typeof fetch;
  expect(await signOutOfAdminPortal(answer({ signOutUrl: null }))).toEqual({ signOutUrl: null });
  expect(await signOutOfAdminPortal(answer({ signOutUrl: "javascript:alert(1)" }))).toEqual({ signOutUrl: null });
  expect(await signOutOfAdminPortal(answer({}, 503))).toEqual({ signOutUrl: null });
  expect(await signOutOfAdminPortal((async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toEqual({ signOutUrl: null });
});

test("signing out goes straight to Core's sign-out URL, replacing this page", async () => {
  const left: string[] = [];
  const fetchMock = (async () => Response.json({ signOutUrl: SIGN_OUT_URL })) as unknown as typeof fetch;
  expect(await signOut({ fetchImpl: fetchMock, leave: url => left.push(url) })).toBe("leaving");
  expect(left).toEqual([SIGN_OUT_URL]);
});

test("without a sign-out URL, or when the call fails, the admin portal stays and shows its own signed-out screen", async () => {
  const left: string[] = [];
  const leave = (url: string) => left.push(url);
  const answer = (body: unknown, status = 200) =>
    (async () => Response.json(body, { status })) as unknown as typeof fetch;
  expect(await signOut({ fetchImpl: answer({ signOutUrl: null }), leave })).toBe("signed-out");
  expect(await signOut({ fetchImpl: answer({}, 503), leave })).toBe("signed-out");
  expect(await signOut({ fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, leave })).toBe("signed-out");
  expect(left).toEqual([]);
});
