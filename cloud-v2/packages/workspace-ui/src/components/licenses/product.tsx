/**
 * A product's look wherever the portal shows one, as the approved design draws it (its `parts2.tsx`): the icon
 * (a letter tile when the product has none we may show), the icon and short name as a chip in a list, and the
 * features a license unlocks as chips.
 *
 * They take what billing's catalog sends and nothing more: a catalog entry, or a card from `joinLicenses`, which
 * carries the same fields. Nothing here names a product, and the only words are the two the strings module has
 * for a feature chip.
 *
 * This file imports no runtime code from the contract, whose schemas bring zod: the Members list draws these
 * chips in the admin portal as well.
 */

import { useState } from "react";
import type { CatalogFeature } from "@mentra/workspace-contract/portal-billing";
import { cn } from "../../lib/utils";
import { licenseStrings as t } from "../../strings/licenses";
import { Badge } from "../common";

/** What an icon, a chip and a letter tile need of a product: a catalog entry or a joined license has them. */
export interface ProductIdentity {
  name: string;
  /** For chips and counts; the name when absent. */
  shortName?: string;
  /** A path billing sent, which is drawn only if it is one of billing's own icons. */
  icon?: string | null;
}

/** Where billing serves product icons. Mirrors the contract's `BILLING_ICON_PATH_PREFIX`. */
const ICON_PATH_PREFIX = "/api/portal/billing/ui/icons/";

/** An icon's file: letters, digits, `.`, `_` and `-`, 1 to 255 of them, and not only dots. Mirrors the contract's. */
const ICON_FILE = /^(?!\.+$)[A-Za-z0-9._-]{1,255}$/;

/**
 * `value` when it is `/api/portal/billing/ui/icons/<file>` with a file the contract allows, else null. The
 * contract's schemas already turn any other icon into null, but a component can be handed anything, and a
 * page must never load an address from elsewhere. This is the contract's `billingIconPath`, copied (see the
 * file's note on zod); a test holds the two to the same answers.
 */
export function usableIcon(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(ICON_PATH_PREFIX)) return null;
  return ICON_FILE.test(value.slice(ICON_PATH_PREFIX.length)) ? value : null;
}

/** The letter a product with no icon gets: the first letter or digit of its name in capitals, else its first character, else "?". */
export function tileLetter(name: string): string {
  const trimmed = name.trim();
  const letter = trimmed.match(/[\p{L}\p{N}]/u)?.[0] ?? Array.from(trimmed)[0];
  return letter ? letter.toLocaleUpperCase() : "?";
}

/**
 * A product's icon: billing's image at `size` px with rounded corners, or, when there is none we may show (not
 * sent, from anywhere but billing's icons, or one that fails to load), a tile with the first letter of its name.
 * Decorative either way: the name is always beside it.
 */
export function ProductIcon({ product, size = 48, className }: { product: Pick<ProductIdentity, "name" | "icon">; size?: number; className?: string }) {
  const src = usableIcon(product.icon);
  const [failed, setFailed] = useState<string | null>(null);
  const box = { width: size, height: size, borderRadius: Math.round(size * 0.28) };
  if (src !== null && failed !== src) {
    return <img src={src} alt="" className={cn("shrink-0 border", className)} style={box} onError={() => setFailed(src)} />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn("bg-surface text-foreground flex shrink-0 items-center justify-center border font-semibold", className)}
      style={{ ...box, fontSize: Math.round(size * 0.42) }}
    >
      {tileLetter(product.name)}
    </span>
  );
}

/** A product in a list: its icon and short name, small. */
export function ProductChip({ product }: { product: ProductIdentity }) {
  return (
    <span className="bg-background inline-flex h-7 items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1 text-xs font-semibold whitespace-nowrap">
      <ProductIcon product={product} size={20} />
      {product.shortName ?? product.name}
    </span>
  );
}

/**
 * What a license unlocks, one chip per feature, with the miniapp it works in. Only for a product with more than
 * one feature: with one (or none) the feature is the product, and this draws nothing.
 */
export function FeatureChips({ product }: { product: { features: readonly CatalogFeature[] } }) {
  if (product.features.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={t.card.includes}>
      {product.features.map((feature, index) => (
        <li key={`${feature.key}-${index}`}>
          <Badge tone="neutral" className="gap-1">
            {feature.name}
            {feature.appName ? (
              <>
                {" "}
                <span className="text-muted-foreground font-normal">{t.card.featureIn(feature.appName)}</span>
              </>
            ) : null}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
