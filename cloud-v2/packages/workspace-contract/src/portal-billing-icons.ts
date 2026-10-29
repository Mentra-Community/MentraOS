/**
 * The rule for a product icon's address, on its own. `portal-billing` re-exports it, but that module builds the
 * contract's zod schemas, and importing it puts zod in a bundle. A screen that only draws a product's icon (the
 * Members list is in the admin portal too) imports this one instead, which needs nothing: no zod, and no other
 * module. Import it from `@mentra/workspace-contract/portal-billing-icons`.
 */

/** Where billing serves product icons, under its `ui/`. */
export const BILLING_ICON_PATH_PREFIX = "/api/portal/billing/ui/icons/"

/**
 * A product icon's file: letters, digits, `.`, `_` and `-`, 1 to 255 of them, and not only dots (`.` and `..`
 * are directories). Nothing else can lead out of the icons directory or into a style or a script.
 */
export const BILLING_ICON_FILE = /^(?!\.+$)[A-Za-z0-9._-]{1,255}$/

/**
 * The icon path billing sent, or null when it isn't `/api/portal/billing/ui/icons/<file>` with a file
 * {@link BILLING_ICON_FILE} allows: no query, fragment, slash, quote, parenthesis or space, and nothing else under
 * `ui/` (the legacy `ui/entry.js` included). The portal shows an icon only from there, so its content security
 * policy holds, no page loads another origin's address, and the path is one Core serves to everyone; a
 * product with no acceptable icon gets a letter tile.
 */
export function billingIconPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(BILLING_ICON_PATH_PREFIX)) return null
  return BILLING_ICON_FILE.test(value.slice(BILLING_ICON_PATH_PREFIX.length)) ? value : null
}
