import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { cleanup, find, render, setupDom, teardownDom } from "../../../../packages/workspace-ui/src/test-dom";
import { closeQueryParam, leavePortal, openPortalTab, openQueryParam, setQueryParam, useSearch } from "./navigation";

// A DOM for the address and the window (happy-dom, as the workspace-ui package's tests use). Synthetic addresses only.
beforeAll(setupDom);
afterAll(teardownDom);
afterEach(cleanup);

/** The addresses the portal follows: https, and http to localhost or 127.0.0.1 for development. */
const FOLLOWED = [
  ["https://billing.example.test/session/abc?x=1", "https://billing.example.test/session/abc?x=1"],
  ["http://localhost:3000/pay", "http://localhost:3000/pay"],
  ["http://127.0.0.1:8080/pay", "http://127.0.0.1:8080/pay"],
  // The canonical form is what is followed: what the parser ignores is gone from it.
  ["  https://billing.example.test/a\tb\n ", "https://billing.example.test/ab"],
] as const;

/** The addresses it refuses, whatever asked for them. */
const REFUSED = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "http://billing.example.test/pay",
  "http://localhost.evil.test/pay",
  "ftp://billing.example.test/pay",
  "https://user:secret@billing.example.test/pay",
  "//billing.example.test/pay",
  "/relative/path",
  "",
  "not a url",
];

describe("leaving the portal in this tab", () => {
  afterEach(() => mock.restore());

  test.each(FOLLOWED)("goes to %s", (url, canonical) => {
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    leavePortal(url);
    expect(assign.mock.calls).toEqual([[canonical]]);
  });

  test.each(REFUSED)("refuses %p: nothing is navigated, and the caller is told", url => {
    const assign = spyOn(window.location, "assign").mockImplementation(() => {});
    expect(() => leavePortal(url)).toThrow();
    expect(assign).not.toHaveBeenCalled();
  });
});

/** A window the portal opened, as far as the portal touches it. */
function fakeTab() {
  const events: string[] = [];
  const tab = {
    opener: "set" as unknown,
    closed: false,
    location: { replace: (url: string) => void events.push(`replace:${url}`) },
    close() {
      tab.closed = true;
      events.push("close");
    },
  };
  return { tab, events };
}

describe("leaving the portal in a tab opened during the click", () => {
  afterEach(() => mock.restore());

  test("opens a blank tab that has no way back to the portal, and sends it on to the page", () => {
    const { tab, events } = fakeTab();
    const open = spyOn(window, "open").mockImplementation((() => tab) as unknown as typeof window.open);
    const handle = openPortalTab();
    expect(open.mock.calls).toEqual([["", "_blank"]]);
    // The new tab can't reach back to this one, which it would through window.opener.
    expect(tab.opener).toBeNull();
    expect(handle).not.toBeNull();
    handle!.go("https://billing.example.test/invoice/1");
    expect(events).toEqual(["replace:https://billing.example.test/invoice/1"]);
  });

  test("closes the tab it opened when asked to, and not before", () => {
    const { tab, events } = fakeTab();
    spyOn(window, "open").mockImplementation((() => tab) as unknown as typeof window.open);
    const handle = openPortalTab()!;
    expect(events).toEqual([]);
    handle.close();
    expect(events).toEqual(["close"]);
  });

  test.each(FOLLOWED)("sends the tab to %s", (url, canonical) => {
    const { tab, events } = fakeTab();
    spyOn(window, "open").mockImplementation((() => tab) as unknown as typeof window.open);
    openPortalTab()!.go(url);
    expect(events).toEqual([`replace:${canonical}`]);
  });

  test.each(REFUSED)("will not send the tab to %p: it closes, and the caller is told", url => {
    const { tab, events } = fakeTab();
    spyOn(window, "open").mockImplementation((() => tab) as unknown as typeof window.open);
    const handle = openPortalTab()!;
    expect(() => handle.go(url)).toThrow();
    expect(events).toEqual(["close"]);
  });

  test("is null when the browser blocked the tab, or would not open one", () => {
    spyOn(window, "open").mockImplementation((() => null) as unknown as typeof window.open);
    expect(openPortalTab()).toBeNull();
    mock.restore();
    spyOn(window, "open").mockImplementation((() => {
      throw new Error("blocked");
    }) as unknown as typeof window.open);
    expect(openPortalTab()).toBeNull();
    mock.restore();
    // A window that is already closed is not a tab to use.
    const { tab } = fakeTab();
    tab.closed = true;
    spyOn(window, "open").mockImplementation((() => tab) as unknown as typeof window.open);
    expect(openPortalTab()).toBeNull();
  });
});

describe("the query parameters the portal keeps in its address", () => {
  afterEach(() => mock.restore());
  const at = (path: string) => window.history.replaceState(null, "", path);
  const here = () => `${window.location.pathname}${window.location.search}`;
  const next = () => new Promise<void>(resolve => setTimeout(resolve, 10));

  test("sets and removes one without touching the others or the path", () => {
    at("/w/ws_acme/licenses?foo=1");
    setQueryParam("purchase", "pur_1");
    expect(here()).toBe("/w/ws_acme/licenses?foo=1&purchase=pur_1");
    setQueryParam("purchase", null);
    expect(here()).toBe("/w/ws_acme/licenses?foo=1");
    setQueryParam("member", "wm_luis");
    expect(here()).toBe("/w/ws_acme/licenses?foo=1&member=wm_luis");
    setQueryParam("member", null);
    expect(here()).toBe("/w/ws_acme/licenses?foo=1");
  });

  test("leaves an address alone when the parameter already has that value, so no history entry is added", () => {
    at("/w/ws_acme/licenses?purchase=pur_1");
    const before = window.history.length;
    setQueryParam("purchase", "pur_1");
    setQueryParam("member", null);
    expect(window.history.length).toBe(before);
    expect(here()).toBe("/w/ws_acme/licenses?purchase=pur_1");
  });

  test("pushes a new history entry unless it is asked to replace the current one", () => {
    at("/w/ws_acme/licenses");
    const before = window.history.length;
    setQueryParam("purchase", "pur_1");
    expect(window.history.length).toBe(before + 1);
    setQueryParam("purchase", null, { replace: true });
    expect(window.history.length).toBe(before + 1);
    expect(here()).toBe("/w/ws_acme/licenses");
  });

  test("reaches the pages that read the address: useSearch follows a set, a removal and Back", async () => {
    at("/w/ws_acme/members");
    function Search() {
      return <output>{useSearch()}</output>;
    }
    await render(<Search />);
    const shown = () => find("output").textContent;
    expect(shown()).toBe("");
    await act(async () => openQueryParam("member", "wm_luis"));
    expect(shown()).toBe("?member=wm_luis");
    await act(async () => window.history.back());
    await next();
    expect(shown()).toBe("");
    await act(async () => setQueryParam("purchase", "pur_1", { replace: true }));
    expect(shown()).toBe("?purchase=pur_1");
    await act(async () => setQueryParam("purchase", null, { replace: true }));
    expect(shown()).toBe("");
  });

  test("opening a panel adds an entry, and Back closes it", async () => {
    at("/w/ws_acme/members");
    openQueryParam("member", "wm_luis");
    expect(here()).toBe("/w/ws_acme/members?member=wm_luis");
    window.history.back();
    await next();
    expect(here()).toBe("/w/ws_acme/members");
  });

  test("closing a panel the portal opened steps Back out of its entry, so Back doesn't land on a copy of the page", async () => {
    at("/w/ws_acme/members");
    openQueryParam("member", "wm_luis");
    const back = spyOn(window.history, "back");
    closeQueryParam("member");
    expect(back).toHaveBeenCalledTimes(1);
    await next();
    expect(here()).toBe("/w/ws_acme/members");
  });

  test("closing a panel the address opened (a link, a reload) removes the parameter in place", async () => {
    at("/w/ws_acme/members?member=wm_luis");
    const before = window.history.length;
    const back = spyOn(window.history, "back");
    closeQueryParam("member");
    expect(back).not.toHaveBeenCalled();
    expect(here()).toBe("/w/ws_acme/members");
    expect(window.history.length).toBe(before);
  });

  test("opening another member while one is open changes the address in place: one Back still closes the panel", async () => {
    at("/w/ws_acme/members");
    openQueryParam("member", "wm_luis");
    const after = window.history.length;
    openQueryParam("member", "wm_amara");
    expect(here()).toBe("/w/ws_acme/members?member=wm_amara");
    expect(window.history.length).toBe(after);
    closeQueryParam("member");
    await next();
    expect(here()).toBe("/w/ws_acme/members");
  });
});
