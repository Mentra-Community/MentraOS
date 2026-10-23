import { describe, expect, test } from "bun:test";
import {
  currentWorkspace,
  fleetItemOf,
  fleetPath,
  forgetWorkspace,
  invitationLanding,
  joinedAddress,
  keepQuery,
  legacyRedirect,
  parseRoute,
  recallWorkspace,
  rememberWorkspace,
  sectionHref,
  workspaceParam,
  type KeyValueStorage,
} from "./routes";

describe("addresses", () => {
  test("the sections have short addresses, and / is the current workspace", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute("/members")).toEqual({ kind: "section", section: "members" });
    expect(parseRoute("/settings/")).toEqual({ kind: "section", section: "settings" });
    expect(parseRoute("/licenses")).toEqual({ kind: "section", section: "licenses" });
    expect(parseRoute("/fleet")).toEqual({ kind: "section", section: "fleet" });
  });

  test("an older /w/<id> address is a legacy workspace address; an unknown section has none", () => {
    expect(parseRoute("/w/ws_1")).toEqual({ kind: "legacy-workspace", workspaceId: "ws_1", section: null });
    expect(parseRoute("/w/ws_1/members")).toEqual({ kind: "legacy-workspace", workspaceId: "ws_1", section: "members" });
    expect(parseRoute("/w/ws_1/fleet")).toEqual({ kind: "legacy-workspace", workspaceId: "ws_1", section: "fleet" });
    expect(parseRoute("/w/ws%2Fodd%20id/settings")).toEqual({ kind: "legacy-workspace", workspaceId: "ws/odd id", section: "settings" });
  });

  test("the personal Billing page is gone: nothing is under /account", () => {
    for (const path of ["/account", "/account/", "/account/billing", "/account/billing/", "/account/other"]) {
      expect(parseRoute(path)).toEqual({ kind: "not-found" });
    }
  });

  test("the workspace audit log is gone: /audit is not found, and an older /w/<id>/audit opens the first section", () => {
    expect(parseRoute("/audit")).toEqual({ kind: "not-found" });
    expect(parseRoute("/w/ws_1/audit")).toEqual({ kind: "legacy-workspace", workspaceId: "ws_1", section: null });
  });

  test("fleet is a workspace section whose items live in ?fleet=", () => {
    expect(fleetPath("ws_1", "ws_1")).toBe("/fleet?fleet=overview");
    expect(fleetPath("ws_1", "ws_1", "people")).toBe("/fleet?fleet=people");
    expect(fleetPath("ws/odd id", "ws_1", "devices")).toBe("/fleet?workspace=ws%2Fodd%20id&fleet=devices");
    expect(fleetPath("ws_1", null, "miniapps")).toBe("/fleet?workspace=ws_1&fleet=miniapps");
    expect(fleetItemOf("?fleet=people")).toBe("people");
    expect(fleetItemOf("?fleet=/devices?tab=phones")).toBe("devices");
    expect(fleetItemOf("?fleet=phones%2Fphone-1")).toBe("devices");
    expect(fleetItemOf("?fleet=/miniapps/com.acme.app")).toBe("miniapps");
    expect(fleetItemOf("?workspace=ws_1&fleet=people")).toBe("people");
    for (const search of ["", "?fleet=", "?fleet=nope", "?x=1"]) expect(fleetItemOf(search)).toBe("overview");
  });

  test("the invitation screen and the enterprise pages have their own addresses", () => {
    expect(parseRoute("/invitation")).toEqual({ kind: "invitation" });
    expect(parseRoute("/enterprise")).toEqual({ kind: "enterprise", page: "overview" });
    expect(parseRoute("/enterprise/environments")).toEqual({ kind: "enterprise", page: "environments" });
    expect(parseRoute("/enterprise/access")).toEqual({ kind: "enterprise", page: "access" });
  });

  test("anything else is not found", () => {
    for (const path of ["/workspaces", "/w", "/w/ws_1/members/extra", "/members/extra", "/enterprise/other", "/w/%E0%A4%A/members", "/invitation/x"]) {
      expect(parseRoute(path)).toEqual({ kind: "not-found" });
    }
  });

  test("an address that carried an invitation lands on the invitation screen, keeping other parameters", () => {
    expect(invitationLanding("http://portal.test/")).toBe("/invitation");
    expect(invitationLanding("http://portal.test/?utm=mail#top")).toBe("/invitation?utm=mail#top");
  });
});

describe("the current workspace", () => {
  const list = [{ workspaceId: "ws_a" }, { workspaceId: "ws_b" }];

  test("?workspace= wins, whether or not the person's list has it (Core decides)", () => {
    expect(workspaceParam("?workspace=ws_b")).toBe("ws_b");
    expect(workspaceParam("?purchase=pur_1&workspace=ws_x")).toBe("ws_x");
    expect(workspaceParam("")).toBeNull();
    expect(workspaceParam("?workspace=")).toBeNull();
    expect(workspaceParam("?workspace=%20")).toBeNull();
    // Two: the first. A malformed one is still an id, which Core will not know.
    expect(workspaceParam("?workspace=ws_a&workspace=ws_b")).toBe("ws_a");
    expect(workspaceParam("?workspace=%E0%A4%A")).not.toBeNull();
    expect(workspaceParam("?workspace=&workspace=ws_b")).toBeNull();
    expect(currentWorkspace({ param: "ws_b", remembered: "ws_a", workspaces: list })).toBe("ws_b");
    expect(currentWorkspace({ param: "ws_other", remembered: "ws_a", workspaces: list })).toBe("ws_other");
    expect(currentWorkspace({ param: "ws_other", remembered: null, workspaces: [] })).toBe("ws_other");
  });

  test("else the remembered workspace while it is in the person's list; else the first; else none", () => {
    expect(currentWorkspace({ param: null, remembered: "ws_b", workspaces: list })).toBe("ws_b");
    expect(currentWorkspace({ param: null, remembered: null, workspaces: list })).toBe("ws_a");
    expect(currentWorkspace({ param: null, remembered: null, workspaces: [] })).toBeNull();
  });

  test("a remembered workspace not in the list (left, or only reachable as an Organization Admin) is ignored", () => {
    expect(currentWorkspace({ param: null, remembered: "ws_gone", workspaces: list })).toBe("ws_a");
    expect(currentWorkspace({ param: null, remembered: "ws_customer", workspaces: [] })).toBeNull();
  });
});

describe("links carry the workspace exactly when the bare address would not open it", () => {
  test("the person's own workspace gets bare addresses", () => {
    expect(sectionHref("members", "ws_a", "ws_a")).toBe("/members");
    expect(sectionHref("settings", "ws_a", "ws_a")).toBe("/settings");
    expect(sectionHref("licenses", "ws_a", "ws_a")).toBe("/licenses");
    expect(sectionHref(null, "ws_a", "ws_a")).toBe("/");
  });

  test("any other workspace is named, encoded", () => {
    expect(sectionHref("members", "ws_X", "ws_a")).toBe("/members?workspace=ws_X");
    expect(sectionHref(null, "ws_X", "ws_a")).toBe("/?workspace=ws_X");
    expect(sectionHref("fleet", "ws_X", null)).toBe("/fleet?workspace=ws_X");
    expect(sectionHref("settings", "ws/odd id", "ws_a")).toBe("/settings?workspace=ws%2Fodd%20id");
  });
});

describe("older addresses redirect to the short ones, keeping the query", () => {
  test("/w/<id> and /w/<id>/<section>", () => {
    expect(legacyRedirect("/w/ws_1", "")).toBe("/?workspace=ws_1");
    expect(legacyRedirect("/w/ws_1/", "")).toBe("/?workspace=ws_1");
    expect(legacyRedirect("/w/ws_1/members", "")).toBe("/members?workspace=ws_1");
    expect(legacyRedirect("/w/ws_1/licenses", "?purchase=pur_1")).toBe("/licenses?workspace=ws_1&purchase=pur_1");
    expect(legacyRedirect("/w/ws_1/members", "?member=wm_2&fleet=x")).toBe("/members?workspace=ws_1&member=wm_2&fleet=x");
    expect(legacyRedirect("/w/ws%2Fodd%20id/settings", "")).toBe("/settings?workspace=ws%2Fodd+id");
  });

  test("the hash is kept when it is given", () => {
    expect(legacyRedirect("/w/ws_1/settings", "?tab=2", "#danger")).toBe("/settings?workspace=ws_1&tab=2#danger");
    expect(legacyRedirect("/w/ws_1", "", "#top")).toBe("/?workspace=ws_1#top");
  });

  test("an unknown section goes to the workspace's first, an unrelated address nowhere", () => {
    expect(legacyRedirect("/w/ws_1/nope", "")).toBe("/?workspace=ws_1");
    expect(legacyRedirect("/w/ws_1/nope", "?purchase=pur_1")).toBe("/?workspace=ws_1&purchase=pur_1");
    for (const path of ["/", "/members", "/account/billing", "/w", "/w/ws_1/members/extra"]) expect(legacyRedirect(path, "")).toBeNull();
  });

  test("a ?workspace= already on the old address does not override the one in its path", () => {
    expect(legacyRedirect("/w/ws_1/members", "?workspace=ws_2")).toBe("/members?workspace=ws_1");
  });
});

describe("a link to another section keeps the rest of the query", () => {
  test("every parameter but the workspace", () => {
    expect(keepQuery("/members", "?purchase=pur_1&tab=2")).toBe("/members?purchase=pur_1&tab=2");
    expect(keepQuery("/members?workspace=ws_x", "?workspace=ws_x&purchase=pur_1")).toBe("/members?workspace=ws_x&purchase=pur_1");
    expect(keepQuery("/members", "?workspace=ws_own")).toBe("/members");
    expect(keepQuery("/", "")).toBe("/");
  });

  test("the hash is kept when it is given", () => {
    expect(keepQuery("/members", "?tab=2", "#danger")).toBe("/members?tab=2#danger");
    expect(keepQuery("/members", "", "#danger")).toBe("/members#danger");
    expect(keepQuery("/members?workspace=ws_x", "", "#top")).toBe("/members?workspace=ws_x#top");
  });
});

describe("joining a workspace from where the person is", () => {
  test("keeps the page and its query, in the workspace joined", () => {
    expect(joinedAddress("/licenses", "?buy=mentra.call.unlimited", "ws_new")).toBe("/licenses?workspace=ws_new&buy=mentra.call.unlimited");
    expect(joinedAddress("/", "", "ws_new")).toBe("/?workspace=ws_new");
    expect(joinedAddress("/members", "?workspace=ws_old", "ws_new")).toBe("/members?workspace=ws_new");
  });

  test("keeps the hash of a page it keeps, and drops it with one it does not", () => {
    expect(joinedAddress("/settings", "", "ws_new", "#danger")).toBe("/settings?workspace=ws_new#danger");
    expect(joinedAddress("/enterprise/access", "", "ws_new", "#x")).toBe("/?workspace=ws_new");
  });

  test("from the invitation screen it opens the workspace at /, and from an enterprise page without its query", () => {
    expect(joinedAddress("/invitation", "?buy=x", "ws_new")).toBe("/?workspace=ws_new&buy=x");
    expect(joinedAddress("/enterprise/access", "?tab=1", "ws_new")).toBe("/?workspace=ws_new");
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
