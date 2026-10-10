import { expect, test } from "bun:test";
import { loginHref, signOutOfAdminPortal } from "./session";

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
    return Response.json({ signOutUrl: "https://account.test/signout" });
  }) as unknown as typeof fetch;
  expect(await signOutOfAdminPortal(fetchMock)).toEqual({ signOutUrl: "https://account.test/signout" });
  expect(calls).toEqual([{ url: "/api/admin/auth/logout", method: "POST" }]);
});

test("a null, unsafe or failed sign-out URL is not offered", async () => {
  const answer = (body: unknown, status = 200) =>
    (async () => Response.json(body, { status })) as unknown as typeof fetch;
  expect(await signOutOfAdminPortal(answer({ signOutUrl: null }))).toEqual({ signOutUrl: null });
  expect(await signOutOfAdminPortal(answer({ signOutUrl: "javascript:alert(1)" }))).toEqual({ signOutUrl: null });
  expect(await signOutOfAdminPortal(answer({}, 503))).toEqual({ signOutUrl: null });
  expect(await signOutOfAdminPortal((async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toEqual({ signOutUrl: null });
});
