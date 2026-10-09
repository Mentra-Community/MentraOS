import { describe, expect, test } from "bun:test";
import {
  readWorkspaceInvite,
  withoutWorkspaceInvite,
  workspaceInviteRedirect,
} from "./workspace-invite-link";

describe("workspace invitation deep link", () => {
  test("reads the token from the query string", () => {
    expect(readWorkspaceInvite("?workspaceInvite=abc_DEF-123")).toBe("abc_DEF-123");
    expect(readWorkspaceInvite("?report=rep_1&workspaceInvite=tok")).toBe("tok");
  });

  test("an absent, empty or repeated parameter is no invitation", () => {
    expect(readWorkspaceInvite("")).toBeNull();
    expect(readWorkspaceInvite("?workspaceInvite=")).toBeNull();
    expect(readWorkspaceInvite("?workspaceInvite=a&workspaceInvite=b")).toBeNull();
    expect(readWorkspaceInvite("?other=1")).toBeNull();
  });

  test("an implausibly long value is no invitation", () => {
    expect(readWorkspaceInvite(`?workspaceInvite=${"a".repeat(513)}`)).toBeNull();
  });

  test("a Developer Console-style /invite/<token> path is the same invitation", () => {
    expect(readWorkspaceInvite("", "/invite/abc_DEF-123")).toBe("abc_DEF-123");
    expect(readWorkspaceInvite("", "/invite/abc/")).toBe("abc");
    expect(readWorkspaceInvite("?workspaceInvite=abc", "/invite/abc")).toBe("abc");
  });

  test("a path that is not exactly /invite/<token>, or disagrees with the query, is no invitation", () => {
    expect(readWorkspaceInvite("", "/invite/")).toBeNull();
    expect(readWorkspaceInvite("", "/invite/a/b")).toBeNull();
    expect(readWorkspaceInvite("", "/invites/abc")).toBeNull();
    expect(readWorkspaceInvite("", `/invite/${"a".repeat(513)}`)).toBeNull();
    expect(readWorkspaceInvite("?workspaceInvite=other", "/invite/abc")).toBeNull();
  });

  test("the server sends /invite/<token> to /?workspaceInvite=<token>, keeping other parameters", () => {
    expect(workspaceInviteRedirect(new URL("https://admin.example.com/invite/abc_DEF-123"))).toBe(
      "/?workspaceInvite=abc_DEF-123",
    );
    expect(workspaceInviteRedirect(new URL("https://admin.example.com/invite/tok?a=1"))).toBe(
      "/?a=1&workspaceInvite=tok",
    );
    // Only a plain base64url token is redirected; anything else falls through to the app.
    expect(workspaceInviteRedirect(new URL("https://admin.example.com/invite/a%20b"))).toBeNull();
    expect(workspaceInviteRedirect(new URL("https://admin.example.com/invite/"))).toBeNull();
    expect(workspaceInviteRedirect(new URL("https://admin.example.com/"))).toBeNull();
    expect(workspaceInviteRedirect(new URL("https://admin.example.com/chunk-abc.js"))).toBeNull();
  });

  test("the token is removed from an address, keeping everything else", () => {
    expect(withoutWorkspaceInvite("https://admin.example.com/invite/tok?a=1#x")).toBe("/?a=1#x");
    expect(withoutWorkspaceInvite("https://admin.example.com/?workspaceInvite=tok")).toBe("/");
    expect(withoutWorkspaceInvite("https://admin.example.com/?a=1&workspaceInvite=tok&b=2#x")).toBe("/?a=1&b=2#x");
    expect(withoutWorkspaceInvite("https://admin.example.com/?a=1")).toBe("/?a=1");
  });
});
