import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { billingIconPath } from "@mentra/workspace-contract/portal-billing";
import { FeatureChips, ProductChip, ProductIcon, tileLetter, usableIcon } from "./components/licenses/product";
import { cleanup, find, findAll, render, setupDom, teardownDom } from "./test-dom";
import { fleetEntryFor, catalogEntryFor } from "./test-billing-fixtures";
import { runtimeImports, SCHEMA_SPECIFIER } from "./test-imports";

beforeAll(setupDom);
afterAll(teardownDom);
afterEach(cleanup);

const ICON = "/api/portal/billing/ui/icons/mentra-call.png";

/** What a screen reader would read: the element's text without anything hidden from it. */
function readText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if ((node as Element).getAttribute?.("aria-hidden") === "true") return "";
  return [...node.childNodes].map(readText).join("");
}

describe("ProductIcon", () => {
  test("draws billing's icon as a decorative image of the size asked, with rounded corners", async () => {
    await render(<ProductIcon product={{ name: "Mentra Call Unlimited", icon: ICON }} size={40} />);
    const img = find<HTMLImageElement>("img");
    expect(img.getAttribute("src")).toBe(ICON);
    expect(img.getAttribute("alt")).toBe("");
    expect(img.style.width).toBe("40px");
    expect(img.style.height).toBe("40px");
    expect(img.style.borderRadius).toBe("11px");
    expect(findAll("span")).toHaveLength(0);
  });

  test("is 48px by default", async () => {
    await render(<ProductIcon product={{ name: "Mentra Call Unlimited", icon: ICON }} />);
    expect(find<HTMLImageElement>("img").style.width).toBe("48px");
  });

  test("with no icon it is a letter tile: the first letter of the name, hidden from a screen reader", async () => {
    await render(<ProductIcon product={{ name: "Fleet", icon: null }} size={36} />);
    expect(findAll("img")).toHaveLength(0);
    const tile = find("span");
    expect(tile.textContent).toBe("F");
    expect(tile.getAttribute("aria-hidden")).toBe("true");
    expect(tile.style.width).toBe("36px");
    expect(tile.style.height).toBe("36px");
  });

  test("an icon that was never sent is the same letter tile", async () => {
    await render(<ProductIcon product={{ name: "example add-on" }} />);
    expect(findAll("img")).toHaveLength(0);
    expect(find("span").textContent).toBe("E");
  });

  test("an icon from anywhere but billing's icons draws the letter tile and never reaches the page", async () => {
    const unusable = [
      "https://evil.example/icon.png",
      "http://localhost:8080/icons/x.png",
      "//evil.example/icon.png",
      "javascript:alert(1)",
      "data:image/svg+xml,<svg/>",
      "/api/portal/billing/ui/entry.js",
      "/api/portal/billing/ui/icons/../entry.js",
      "/api/portal/billing/ui/icons/x.png?track=1",
      "/api/portal/billing/ui/icons/",
      "/other/icons/x.png",
      "icons/x.png",
      "",
    ];
    for (const icon of unusable) {
      await render(<ProductIcon product={{ name: "Mentra Call", icon }} />);
      expect(findAll("img")).toHaveLength(0);
      expect(find("span").textContent).toBe("M");
      expect(document.body.innerHTML).not.toContain("evil.example");
      await cleanup();
    }
  });

  test("an icon that fails to load falls back to the letter tile, and a new icon is tried again", async () => {
    const view = await render(<ProductIcon product={{ name: "Mentra Call", icon: ICON }} />);
    const img = find<HTMLImageElement>("img");
    await act(async () => void img.dispatchEvent(new Event("error")));
    expect(findAll("img")).toHaveLength(0);
    expect(find("span").textContent).toBe("M");
    await view.rerender(<ProductIcon product={{ name: "Mentra Call", icon: "/api/portal/billing/ui/icons/other.png" }} />);
    expect(find<HTMLImageElement>("img").getAttribute("src")).toBe("/api/portal/billing/ui/icons/other.png");
  });

  test("renders on the server as an image or a tile, with no browser", () => {
    expect(renderToStaticMarkup(<ProductIcon product={{ name: "A", icon: ICON }} />)).toContain(`src="${ICON}"`);
    expect(renderToStaticMarkup(<ProductIcon product={{ name: "Acme", icon: null }} />)).toContain(">A<");
  });
});

describe("the letter of a tile", () => {
  test("is the first letter or digit, in capitals", () => {
    expect(tileLetter("Fleet")).toBe("F");
    expect(tileLetter("  mentra.call.unlimited")).toBe("M");
    expect(tileLetter("3D Maps")).toBe("3");
    expect(tileLetter("Éclair")).toBe("É");
    expect(tileLetter("— Plan")).toBe("P");
  });

  test("is a question mark when the name has none", () => {
    expect(tileLetter("")).toBe("?");
    expect(tileLetter("   ")).toBe("?");
    expect(tileLetter("—")).toBe("—");
  });
});

describe("usableIcon is the contract's rule", () => {
  // The component can't import the contract's check (it lives beside zod, which an embedder that only draws
  // chips must not carry), so it keeps a copy. These are the paths the two must agree on.
  const PREFIX = "/api/portal/billing/ui/icons/";
  const samples: unknown[] = [
    ICON,
    `${PREFIX}a_b-c.1.svg`,
    `${PREFIX}${"a".repeat(255)}`,
    `${PREFIX}${"a".repeat(256)}`,
    `${PREFIX}.hidden`,
    `${PREFIX}.`,
    `${PREFIX}..`,
    `${PREFIX}...`,
    `${PREFIX}`,
    `${PREFIX}x.png?a=b`,
    `${PREFIX}x.png#frag`,
    `${PREFIX}sub/x.png`,
    `${PREFIX}x y.png`,
    `${PREFIX}x".png`,
    `${PREFIX}x(1).png`,
    `${PREFIX}x'.png`,
    `${PREFIX}é.png`,
    `${PREFIX}x.png\n`,
    `${PREFIX}%2e%2e`,
    "/api/portal/billing/ui/entry.js",
    "/api/portal/billing/ui/icons",
    "/API/portal/billing/ui/icons/x.png",
    "https://evil.example/api/portal/billing/ui/icons/x.png",
    "javascript:alert(1)",
    "",
    null,
    undefined,
    42,
    {},
  ];

  test("every sample is accepted or refused exactly as billingIconPath does", () => {
    for (const sample of samples) expect([sample, usableIcon(sample)]).toEqual([sample, billingIconPath(sample)]);
  });

  test("a usable path comes back as it was", () => {
    expect(usableIcon(ICON)).toBe(ICON);
    expect(usableIcon("https://evil.example/x.png")).toBeNull();
  });
});

describe("ProductChip", () => {
  test("is the icon, small, and the short name", async () => {
    await render(<ProductChip product={{ name: "Mentra Call Unlimited", shortName: "Call Unlimited", icon: ICON }} />);
    const chip = find("span");
    expect(chip.textContent).toBe("Call Unlimited");
    const img = find<HTMLImageElement>("img", chip);
    expect(img.style.width).toBe("20px");
    expect(img.getAttribute("alt")).toBe("");
  });

  test("uses the name when billing sent no short name, and a tile when it sent no icon", async () => {
    await render(<ProductChip product={fleetEntryFor()} />);
    const chip = find("span");
    expect(readText(chip)).toBe("Fleet");
    expect(findAll("img", chip)).toHaveLength(0);
    expect(find("[aria-hidden='true']", chip).textContent).toBe("F");
  });

  test("an icon outside billing's own draws a tile", async () => {
    await render(<ProductChip product={{ name: "Call", icon: "https://evil.example/x.png" }} />);
    expect(findAll("img")).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain("evil.example");
  });

  test("takes a catalog entry as it is", async () => {
    await render(<ProductChip product={catalogEntryFor()} />);
    expect(find("span").textContent).toBe("Call Unlimited");
  });
});

describe("FeatureChips", () => {
  test("is a list labelled Includes with a chip per feature, and the miniapp each is for", async () => {
    await render(<FeatureChips product={{ features: [{ key: "a", name: "Managed phones and glasses" }, { key: "b", name: "Unlimited Teams calls", appName: "Mentra Call" }] }} />);
    const list = find("ul");
    expect(list.getAttribute("aria-label")).toBe("Includes");
    const items = findAll("li", list);
    expect(items.map((item) => item.textContent)).toEqual(["Managed phones and glasses", "Unlimited Teams calls in Mentra Call"]);
  });

  test("takes a catalog entry as it is", async () => {
    await render(<FeatureChips product={fleetEntryFor()} />);
    expect(findAll("li").map((item) => item.textContent)).toEqual(["Managed phones and glasses", "Miniapp assignments", "Usage reports"]);
  });

  test("shows features only when there is more than one: with one, the feature is the product", async () => {
    await render(<FeatureChips product={catalogEntryFor()} />);
    expect(document.body.innerHTML).toBe("<div></div>");
    await cleanup();
    await render(<FeatureChips product={{ features: [] }} />);
    expect(findAll("ul")).toHaveLength(0);
  });

  test("renders on the server", () => {
    const markup = renderToStaticMarkup(<FeatureChips product={fleetEntryFor()} />);
    expect(markup).toContain("Usage reports");
    expect(markup).toContain('aria-label="Includes"');
  });
});

describe("what the product pieces pull in", () => {
  test("they reach neither the contract's schemas nor zod, so the Members list can draw chips without carrying them", () => {
    expect(runtimeImports("components/licenses/product.tsx").specifiers.filter((specifier) => SCHEMA_SPECIFIER.test(specifier))).toEqual([]);
  });
});
