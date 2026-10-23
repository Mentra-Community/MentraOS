import { afterEach, describe, expect, test } from "bun:test";
import type { FetchLike } from "@mentra/workspace-ui";
import { DEFAULT_PORTAL_LOCALE, portalLocale } from "./locale";
import { createPortalBillingApi } from "./portal";
import { workspaceScope } from "@mentra/workspace-ui";

describe("the portal's locale", () => {
  test("is the first of the browser's languages the portal has strings for, keeping its region", () => {
    expect(portalLocale(["en-GB"])).toBe("en-GB");
    expect(portalLocale(["en-AU", "en-US"])).toBe("en-AU");
    // Languages without strings are passed over, not matched by a later region.
    expect(portalLocale(["de-DE", "fr-FR", "en-CA"])).toBe("en-CA");
  });

  test("is en-US when none of the languages is one the portal has strings for, or there are none", () => {
    expect(portalLocale(["de-DE"])).toBe("en-US");
    expect(portalLocale(["de-DE", "ja"])).toBe("en-US");
    expect(portalLocale([])).toBe("en-US");
    // Asked of a browser that tells it nothing (Bun's `navigator` has no languages): the default.
    expect(portalLocale()).toBe("en-US");
    expect(DEFAULT_PORTAL_LOCALE).toBe("en-US");
  });

  test("keeps no more than the language and its region, and spells them as BCP 47 does", () => {
    expect(portalLocale(["en"])).toBe("en");
    expect(portalLocale(["EN-gb"])).toBe("en-GB");
    expect(portalLocale(["en-Latn-GB-u-ca-buddhist"])).toBe("en-GB");
  });

  test("passes over a tag that is not a language tag at all", () => {
    expect(portalLocale(["", "not a tag", "en-NZ"])).toBe("en-NZ");
    expect(portalLocale(["", "!!"])).toBe("en-US");
  });
});

describe("the locale billing is asked in", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "languages");
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "languages", original);
    else delete (navigator as { languages?: unknown }).languages;
  });

  const withLanguages = (languages: string[]) => Object.defineProperty(navigator, "languages", { configurable: true, value: languages });

  /** The requests a client made over a fetch that answers every one with a refusal (the locale is on the request itself). */
  async function requestsOf(languages: string[]) {
    withLanguages(languages);
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetch: FetchLike = async (input, init) => {
      seen.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ error: "billing_unavailable" }, { status: 503 });
    };
    const billing = createPortalBillingApi({ fetch });
    const scope = workspaceScope("ws_acme");
    await billing.catalog(scope).catch(() => undefined);
    await billing.status(scope, { purchase: "pur_1" }).catch(() => undefined);
    await billing.purchase(scope, { product: "mentra.fleet", seats: 3 }).catch(() => undefined);
    await billing.session(scope, { action: "billing_and_invoices" }).catch(() => undefined);
    return { billing, seen };
  }

  test("billing requests carry the browser's language when the portal has strings for it: locale=en-GB", async () => {
    const { billing, seen } = await requestsOf(["en-GB"]);
    expect(billing.locale).toBe("en-GB");
    const [catalog, status, purchase, session] = seen;
    expect(new URL(catalog!.url, "https://portal.test").searchParams.get("locale")).toBe("en-GB");
    expect(new URL(status!.url, "https://portal.test").searchParams.get("locale")).toBe("en-GB");
    expect(new URL(status!.url, "https://portal.test").searchParams.get("purchase")).toBe("pur_1");
    expect((purchase!.body as { locale: string }).locale).toBe("en-GB");
    expect((session!.body as { locale: string }).locale).toBe("en-GB");
  });

  test("and en-US when it has none for the browser's: de-DE is asked for in en-US", async () => {
    const { billing, seen } = await requestsOf(["de-DE"]);
    expect(billing.locale).toBe("en-US");
    expect(new URL(seen[0]!.url, "https://portal.test").searchParams.get("locale")).toBe("en-US");
    expect((seen[2]!.body as { locale: string }).locale).toBe("en-US");
  });

  test("never sends the browser's raw preferences: no accept-language, and no language the portal can't show", async () => {
    withLanguages(["de-DE", "en-GB"]);
    const headers: Array<Record<string, string>> = [];
    const fetch: FetchLike = async (_input, init) => {
      headers.push({ ...(init?.headers as Record<string, string>) });
      return Response.json({ error: "billing_unavailable" }, { status: 503 });
    };
    await createPortalBillingApi({ fetch }).catalog(workspaceScope("ws_acme")).catch(() => undefined);
    expect(Object.keys(headers[0]!).map(name => name.toLowerCase())).not.toContain("accept-language");
  });
});
