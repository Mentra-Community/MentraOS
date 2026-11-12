/**
 * Opening the miniapp a subscription is for, from the dialog that says the viewer has it: on a phone, "Open <miniapp>"
 * is a package link the Mentra App opens; on a computer there is no such button.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { WorkspaceApi } from "./api";
import { LinkDialog } from "./components/licenses/buy-link";
import { PurchaseDialog } from "./components/licenses/purchase-dialog";
import { licenseMiniapp, miniappLink, onPhone } from "./lib/miniapp-link";
import { catalogEntryFor } from "./test-billing-fixtures";
import { cleanup, find, findAll, render, setupDom, teardownDom, until } from "./test-dom";
import { detailFor, licenseFor, offlineApi } from "./test-fixtures";

beforeAll(setupDom);
afterAll(teardownDom);
afterEach(cleanup);

const CALL = { packageName: "com.mentra.call", appName: "Mentra Call" };
const openLink = () => findAll<HTMLAnchorElement>("dialog a").find((anchor) => anchor.textContent === "Open Mentra Call") ?? null;

async function mount(ui: ReactElement) {
  await render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("the package link", () => {
  test("opens the package in the Mentra App, through the directory website it claims", () => {
    expect(miniappLink("com.mentra.call")).toBe("https://apps.mentraglass.com/package/com.mentra.call");
    expect(miniappLink("a b/c")).toBe("https://apps.mentraglass.com/package/a%20b%2Fc");
  });

  test("a license is for the first package its features name; a service's feature names none", () => {
    expect(licenseMiniapp(licenseFor())).toBe("com.mentra.call");
    expect(licenseMiniapp(licenseFor({ features: [{ key: "fleet.usage", packages: [] }, { key: "x", packages: ["com.x", "com.y"] }] }))).toBe("com.x");
    expect(licenseMiniapp(licenseFor({ features: [{ key: "fleet.usage", packages: [] }] }))).toBeNull();
  });

  test("a phone or a tablet is where the Mentra App is; a computer is not", () => {
    const at = (userAgent: string, maxTouchPoints = 0) => onPhone({ userAgent, maxTouchPoints });
    expect(at("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36")).toBe(true);
    expect(at("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Telegram-iOS")).toBe(true);
    // An iPad says it is a Mac, with a touch screen.
    expect(at("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 5)).toBe(true);
    expect(at("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15")).toBe(false);
    expect(at("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36")).toBe(false);
    expect(onPhone(undefined)).toBe(false);
  });
});

describe("after checkout, given one", () => {
  const ready = { status: "ready" as const, quantity: 1, paid: true };
  const dialog = (over: Partial<Parameters<typeof PurchaseDialog>[0]> = {}) => (
    <PurchaseDialog purchase={ready} productName="Mentra Call Unlimited Plan" entry={catalogEntryFor()} listed assigned app={CALL} phone onClose={() => {}} {...over} />
  );

  test("on a phone it offers Open Mentra Call, a link the Mentra App opens, beside OK", async () => {
    await mount(dialog());
    expect(openLink()!.getAttribute("href")).toBe("https://apps.mentraglass.com/package/com.mentra.call");
    expect(findAll("dialog button").map((button) => button.textContent)).toContain("OK");
  });

  test("with no miniapp name from billing it opens the Mentra App by that name", async () => {
    await mount(dialog({ app: { packageName: "com.mentra.call", appName: null } }));
    expect(find("dialog a").textContent).toBe("Open the Mentra App");
  });

  test("on a computer, for a license that is for no miniapp, or before it is the viewer's, there is none", async () => {
    for (const over of [{ phone: false }, { app: null }, { assigned: false }, { purchase: { ...ready, status: "processing" as const }, listed: false }]) {
      await mount(dialog(over));
      expect([over, findAll("dialog a").length]).toEqual([over, 0]);
      await cleanup();
    }
  });
});

describe("a ?buy= link that assigned a free one", () => {
  const assigning = (assignSeat: WorkspaceApi["assignSeat"]) => ({ ...offlineApi().api, assignSeat }) as WorkspaceApi;
  const entry = catalogEntryFor();
  const link = (api: WorkspaceApi, phone: boolean) => (
    <LinkDialog
      outcome={{ product: entry.product, entry, kind: "assign", licenseId: "lic_call" }}
      workspace={detailFor("admin") as never}
      api={api}
      billing={{ locale: "en-US" } as never}
      scope={{ workspaceId: "ws_acme" } as never}
      navigateOut={{ leave: () => {}, openTab: () => null }}
      app={CALL}
      phone={phone}
      onClose={() => {}}
    />
  );

  test("on a phone, once it is assigned, offers Open Mentra Call beside Done", async () => {
    await mount(link(assigning(async () => licenseFor()), true));
    await until(() => openLink() !== null, "the open link");
    expect(openLink()!.getAttribute("href")).toBe("https://apps.mentraglass.com/package/com.mentra.call");
    expect(findAll("dialog button").map((button) => button.textContent)).toContain("Done");
  });

  test("on a computer it does not", async () => {
    await mount(link(assigning(async () => licenseFor()), false));
    await until(() => (find("dialog h2").textContent ?? "").startsWith("You now have"), "the assignment");
    expect(findAll("dialog a")).toHaveLength(0);
  });
});
