import { describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../lib/api";
import {
  defaultGrantEnd,
  grantedMessage,
  grantKeyFor,
  grantLicenses,
  grantProductName,
  grantRefusalMessage,
  grantSignature,
  grantToSend,
  latestGrantEnd,
  LicenseGrantDialog,
  parseGrantForm,
} from "./workspace-license-grant";

// Synthetic data only.
const NOW = Date.UTC(2026, 10, 26, 12);
const form = { product: "mentra.call.unlimited", seats: "5", endsOn: "2027-11-26", note: "" };

describe("the grant form", () => {
  test("starts a year out, and offers no date past a grant's longest term", () => {
    expect(defaultGrantEnd(NOW)).toBe("2027-11-26");
    expect(latestGrantEnd(NOW)).toBe("2028-11-25");
    expect(parseGrantForm({ ...form, endsOn: defaultGrantEnd(NOW) }, NOW).ok).toBe(true);
    expect(parseGrantForm({ ...form, endsOn: latestGrantEnd(NOW) }, NOW).ok).toBe(true);
  });

  test("makes the grant Core's route takes, the note only when there is one", () => {
    expect(parseGrantForm(form, NOW)).toEqual({ ok: true, body: { product: "mentra.call.unlimited", seats: 5, endsAt: "2027-11-26" } });
    expect(parseGrantForm({ ...form, seats: " 12 ", note: "  Reseller, invoice 1042 " }, NOW)).toEqual({
      ok: true,
      body: { product: "mentra.call.unlimited", seats: 12, endsAt: "2027-11-26", note: "Reseller, invoice 1042" },
    });
  });

  test("says what is wrong in words", () => {
    const message = (change: Partial<typeof form>) => {
      const parsed = parseGrantForm({ ...form, ...change }, NOW);
      return parsed.ok ? null : parsed.message;
    };
    expect(message({ product: " " })).toBe("Choose a product.");
    for (const seats of ["", "0", "1001", "2.5", "-1", "five"]) expect(message({ seats })).toBe("Enter how many licenses, from 1 to 1000.");
    expect(message({ endsOn: "" })).toBe("Enter the date the licenses end.");
    expect(message({ endsOn: "2027-02-30" })).toBe("Enter the date the licenses end.");
    expect(message({ endsOn: "2026-11-26" })).toBe("The end date must be in the future.");
    expect(message({ endsOn: "2028-11-27" })).toBe("The end date can be at most 730 days from today.");
    expect(message({ note: "x".repeat(501) })).toBe("The note is at most 500 characters.");
    expect(message({ product: "Mentra Call" })).toContain("That can't be granted");
  });

  test("offers the product by name and explains that nothing is charged", () => {
    const client = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <LicenseGrantDialog workspace={{ workspaceId: "ws_acme", name: "Acme Robotics" }} now={NOW} onClose={() => {}} onGranted={() => {}} />
      </QueryClientProvider>,
    );
    expect(markup).toContain("Grant licenses");
    expect(markup).toContain("<strong>Acme Robotics</strong>");
    expect(markup).toContain("Nothing is charged");
    expect(markup).toContain("Mentra Call Unlimited");
    expect(markup).toContain('value="2027-11-26"');
    expect(markup).toContain('max="2028-11-25"');
    expect(markup).not.toContain('role="alert"');
  });
});

describe("granting", () => {
  test("posts the grant with its idempotency key, and waits as long as Core may take", async () => {
    const grant = {
      workspaceId: "ws_acme",
      product: "mentra.call.unlimited",
      seats: 5,
      endsAt: "2027-11-26T00:00:00Z",
      status: "trialing",
      subscriptionId: "sub_1",
      licenseId: null,
      replayed: false,
    };
    let seen: { url: string; init: RequestInit } | null = null;
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return Response.json(grant, { status: 201 });
    }) as unknown as typeof fetch);
    try {
      expect(await grantLicenses("ws/acme", { product: "mentra.call.unlimited", seats: 5, endsAt: "2027-11-26" }, "key-1")).toEqual(grant);
      expect(seen!.url).toBe("/api/admin/organization/workspaces/ws%2Facme/license-grants");
      expect(seen!.init.method).toBe("POST");
      expect((seen!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-1");
      expect(JSON.parse(String(seen!.init.body))).toEqual({ product: "mentra.call.unlimited", seats: 5, endsAt: "2027-11-26" });
    } finally {
      spy.mockRestore();
    }
  });

  test("a retry of the grant already asked for is sent even once its end is near, so Core can answer it by its key", () => {
    const late = Date.UTC(2027, 10, 25, 23, 30); // half an hour before the end the form asked for
    const parsedEarlier = parseGrantForm(form, NOW);
    if (!parsedEarlier.ok) throw new Error("the grant was valid when first asked for");
    const previous = { signature: grantSignature(parsedEarlier.body) };
    expect(grantToSend(form, late, previous)).toEqual(parsedEarlier);
    // A new grant, or none asked for before, is still held to the rule.
    expect(grantToSend(form, late, null)).toEqual({ ok: false, message: "The end date must be in the future." });
    expect(grantToSend({ ...form, seats: "6" }, late, previous)).toEqual({ ok: false, message: "The end date must be in the future." });
  });

  test("the same grant keeps its key, so a retry makes nothing new; a changed one takes a new key", () => {
    const body = { product: "mentra.call.unlimited", seats: 5, endsAt: "2027-11-26" };
    let made = 0;
    const newKey = () => `key-${++made}`;
    const first = grantKeyFor(null, body, newKey);
    expect(first.key).toBe("key-1");
    expect(grantKeyFor(first, { ...body }, newKey)).toBe(first);
    expect(grantKeyFor(first, { ...body, seats: 6 }, newKey).key).toBe("key-2");
    expect(grantKeyFor(first, { ...body, note: "invoice 1042" }, newKey).key).toBe("key-3");
  });

  test("says what was granted, and that nothing was charged", () => {
    const grant = { product: "mentra.call.unlimited", seats: 5, endsAt: "2027-11-26T00:00:00Z" };
    expect(grantedMessage("Acme Robotics", grant)).toBe(
      "Acme Robotics now has 5 licenses of Mentra Call Unlimited until Nov 26, 2027. Nothing was charged. Its admins assign them to people on the workspace's Licenses page.",
    );
    expect(grantedMessage("Acme Robotics", { ...grant, seats: 1, product: "mentra.other" })).toContain("1 license of mentra.other until");
    expect(grantProductName("mentra.call.unlimited")).toBe("Mentra Call Unlimited");
  });

  test("puts each refusal in the admin's words", () => {
    const refused = (code: string) => grantRefusalMessage(new ApiError("as Core said it", 409, code));
    expect(refused("already_licensed")).toContain("already holds this product");
    expect(refused("not_for_sale")).toContain("doesn't sell this product per license");
    expect(refused("checkout_in_progress")).toContain("Try again in a minute");
    expect(refused("billing_unavailable")).toContain("granting again is safe");
    expect(refused("idempotency_conflict")).toContain("start again");
    expect(refused("workspace_not_found")).toBe("This workspace no longer exists.");
    expect(refused("something_new")).toBe("as Core said it");
    expect(grantRefusalMessage(new Error("Request timed out. Please try again."))).toBe("Request timed out. Please try again.");
  });
});
