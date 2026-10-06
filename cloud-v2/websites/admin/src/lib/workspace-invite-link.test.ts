import { describe, expect, test } from "bun:test";
import { readWorkspaceInvite, withoutWorkspaceInvite } from "./workspace-invite-link";

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

  test("the token is removed from an address, keeping everything else", () => {
    expect(withoutWorkspaceInvite("https://admin.example.com/?workspaceInvite=tok")).toBe("/");
    expect(withoutWorkspaceInvite("https://admin.example.com/?a=1&workspaceInvite=tok&b=2#x")).toBe("/?a=1&b=2#x");
    expect(withoutWorkspaceInvite("https://admin.example.com/?a=1")).toBe("/?a=1");
  });
});
