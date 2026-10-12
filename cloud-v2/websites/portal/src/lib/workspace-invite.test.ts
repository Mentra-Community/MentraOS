import { describe, expect, test } from "bun:test";
import { forgetPendingInvite, readWorkspaceInvite, takePendingInvite, withoutWorkspaceInvite, type InviteStorage } from "./workspace-invite";

function memoryStorage(): InviteStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: key => void data.delete(key),
  };
}

function at(href: string) {
  const url = new URL(href);
  return { href: url.href, search: url.search, pathname: url.pathname };
}

describe("reading an invitation link", () => {
  test("reads the query form and the /invite/<token> form", () => {
    expect(readWorkspaceInvite("?workspaceInvite=abc_-1", "/")).toBe("abc_-1");
    expect(readWorkspaceInvite("", "/invite/abc_-1")).toBe("abc_-1");
    expect(readWorkspaceInvite("", "/invite/abc/")).toBe("abc");
    expect(readWorkspaceInvite("", "/")).toBeNull();
  });

  test("anything ambiguous or implausible is no invitation", () => {
    expect(readWorkspaceInvite("?workspaceInvite=a&workspaceInvite=b", "/")).toBeNull();
    expect(readWorkspaceInvite("?workspaceInvite=a", "/invite/b")).toBeNull();
    expect(readWorkspaceInvite(`?workspaceInvite=${"x".repeat(513)}`, "/")).toBeNull();
    expect(readWorkspaceInvite("?workspaceInvite=", "/")).toBeNull();
  });

  test("removing the token keeps the rest of the address", () => {
    expect(withoutWorkspaceInvite("https://portal.test/?workspaceInvite=abc&x=1#h")).toBe("/?x=1#h");
    expect(withoutWorkspaceInvite("https://portal.test/invite/abc?x=1")).toBe("/?x=1");
  });
});

describe("the pending invitation", () => {
  test("a link's token moves from the address into session storage before anything else sees it", () => {
    const storage = memoryStorage();
    const replaced: string[] = [];
    const token = takePendingInvite(at("https://portal.test/?workspaceInvite=tok_1"), storage, url => replaced.push(url));
    expect(token).toBe("tok_1");
    expect(replaced).toEqual(["/"]);
    expect([...storage.data.values()]).toEqual(["tok_1"]);
  });

  test("after the sign-in round trip the stored token is still pending, and forgetting it ends that", () => {
    const storage = memoryStorage();
    takePendingInvite(at("https://portal.test/invite/tok_2"), storage, () => {});
    const replaced: string[] = [];
    expect(takePendingInvite(at("https://portal.test/"), storage, url => replaced.push(url))).toBe("tok_2");
    expect(replaced).toEqual([]);
    forgetPendingInvite(storage);
    expect(takePendingInvite(at("https://portal.test/"), storage, () => {})).toBeNull();
  });

  test("works without storage, and an unusable link is still removed from the address", () => {
    expect(takePendingInvite(at("https://portal.test/?workspaceInvite=tok_3"), null, () => {})).toBe("tok_3");
    const replaced: string[] = [];
    expect(takePendingInvite(at("https://portal.test/?workspaceInvite=a&workspaceInvite=b"), memoryStorage(), url => replaced.push(url))).toBeNull();
    expect(replaced).toEqual(["/"]);
  });
});
