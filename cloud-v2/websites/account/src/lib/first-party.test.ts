import { describe, expect, test } from "bun:test";
import { isFirstPartyClient, parseFirstPartyClientIds } from "./first-party";

describe("FIRST_PARTY_CLIENT_IDS", () => {
  test("parsing trims entries and drops empty ones", () => {
    expect([...parseFirstPartyClientIds(" admin-dev , ,portal-prod,,  cli ,")]).toEqual(["admin-dev", "portal-prod", "cli"]);
    expect(parseFirstPartyClientIds(undefined).size).toBe(0);
    expect(parseFirstPartyClientIds("").size).toBe(0);
    expect(parseFirstPartyClientIds(" , ").size).toBe(0);

    const ids = parseFirstPartyClientIds("a,b");
    expect(isFirstPartyClient(ids, "a")).toBe(true);
    expect(isFirstPartyClient(ids, " a")).toBe(false);
    expect(isFirstPartyClient(ids, "c")).toBe(false);
    expect(isFirstPartyClient(ids, "")).toBe(false);
    expect(isFirstPartyClient(ids, undefined)).toBe(false);
  });
});
