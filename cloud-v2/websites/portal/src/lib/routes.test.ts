import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_BILLING_PATH,
  forgetWorkspace,
  homeWorkspace,
  invitationLanding,
  parseRoute,
  recallWorkspace,
  rememberWorkspace,
  workspacePath,
  type KeyValueStorage,
} from "./routes";

describe("addresses", () => {
  test("every workspace page carries its workspace", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute("/w/ws_1/members")).toEqual({ kind: "workspace", workspaceId: "ws_1", section: "members" });
    expect(parseRoute("/w/ws_1/settings/")).toEqual({ kind: "workspace", workspaceId: "ws_1", section: "settings" });
    expect(parseRoute("/w/ws_1/audit")).toEqual({ kind: "workspace", workspaceId: "ws_1", section: "audit" });
    expect(parseRoute("/w/ws_1/licenses")).toEqual({ kind: "workspace", workspaceId: "ws_1", section: "licenses" });
    expect(workspacePath("ws_1", "licenses")).toBe("/w/ws_1/licenses");
  });

  test("the personal Billing page is at /account/billing, and nothing else is under /account", () => {
    expect(ACCOUNT_BILLING_PATH).toBe("/account/billing");
    expect(parseRoute("/account/billing")).toEqual({ kind: "account-billing" });
    expect(parseRoute("/account/billing/")).toEqual({ kind: "account-billing" });
    for (const path of ["/account", "/account/", "/account/other", "/account/billing/extra", "/accounts/billing"]) {
      expect(parseRoute(path)).toEqual({ kind: "not-found" });
    }
  });

  test("a workspace without a section, or with one the portal does not have, opens its first section", () => {
    expect(parseRoute("/w/ws_1")).toEqual({ kind: "workspace", workspaceId: "ws_1", section: null });
    expect(parseRoute("/w/ws_1/fleet")).toEqual({ kind: "workspace", workspaceId: "ws_1", section: null });
  });

  test("the invitation screen and the enterprise pages have their own addresses", () => {
    expect(parseRoute("/invitation")).toEqual({ kind: "invitation" });
    expect(parseRoute("/enterprise")).toEqual({ kind: "enterprise", page: "overview" });
    expect(parseRoute("/enterprise/environments")).toEqual({ kind: "enterprise", page: "environments" });
    expect(parseRoute("/enterprise/access")).toEqual({ kind: "enterprise", page: "access" });
  });

  test("anything else is not found", () => {
    for (const path of ["/workspaces", "/w", "/w/ws_1/members/extra", "/enterprise/other", "/w/%E0%A4%A/members", "/invitation/x"]) {
      expect(parseRoute(path)).toEqual({ kind: "not-found" });
    }
  });

  test("workspace ids are encoded into paths and decoded back", () => {
    const path = workspacePath("ws/odd id", "settings");
    expect(path).toBe("/w/ws%2Fodd%20id/settings");
    expect(parseRoute(path)).toEqual({ kind: "workspace", workspaceId: "ws/odd id", section: "settings" });
    expect(workspacePath("ws_1")).toBe("/w/ws_1");
  });

  test("an address that carried an invitation lands on the invitation screen, keeping other parameters", () => {
    expect(invitationLanding("http://portal.test/")).toBe("/invitation");
    expect(invitationLanding("http://portal.test/?utm=mail#top")).toBe("/invitation?utm=mail#top");
  });
});

describe("the last-used workspace is a convenience, never an authority", () => {
  function memory(): KeyValueStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: key => void data.delete(key),
    };
  }
  const list = [{ workspaceId: "ws_a" }, { workspaceId: "ws_b" }];

  test("/ opens the remembered workspace while it is still in the list, else the first, else none", () => {
    expect(homeWorkspace(list, "ws_b")).toBe("ws_b");
    expect(homeWorkspace(list, "ws_gone")).toBe("ws_a");
    expect(homeWorkspace(list, null)).toBe("ws_a");
    expect(homeWorkspace([], "ws_b")).toBeNull();
  });

  test("remembers, recalls and forgets only the workspace named", () => {
    const storage = memory();
    rememberWorkspace(storage, "ws_b");
    expect(recallWorkspace(storage)).toBe("ws_b");
    forgetWorkspace(storage, "ws_a");
    expect(recallWorkspace(storage)).toBe("ws_b");
    forgetWorkspace(storage, "ws_b");
    expect(recallWorkspace(storage)).toBeNull();
  });

  test("a storage that refuses (private mode) or is missing changes nothing", () => {
    const refusing: KeyValueStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => rememberWorkspace(refusing, "ws_a")).not.toThrow();
    expect(recallWorkspace(refusing)).toBeNull();
    expect(() => forgetWorkspace(refusing, "ws_a")).not.toThrow();
    expect(recallWorkspace(null)).toBeNull();
  });
});
