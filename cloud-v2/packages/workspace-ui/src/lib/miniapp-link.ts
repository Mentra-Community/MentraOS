/**
 * Opening a miniapp in the Mentra App from a web page. The Mentra App claims `apps.mentraglass.com` as Universal Links
 * (iOS) and App Links (Android): a package link opens the miniapp when it is installed and offers to install it when
 * it isn't. Where the Mentra App isn't installed, the browser shows the directory's page for the miniapp instead.
 */

import type { LicenseView } from "@mentra/workspace-contract";

/** The directory website, whose links the Mentra App opens. */
const DIRECTORY_WEBSITE = "https://apps.mentraglass.com";

/** The package link that opens `packageName` in the Mentra App. */
export function miniappLink(packageName: string): string {
  return `${DIRECTORY_WEBSITE}/package/${encodeURIComponent(packageName)}`;
}

/** The miniapp a license is for: the first package its features name (a feature with none is a service's), or null. */
export function licenseMiniapp(license: Pick<LicenseView, "features">): string | null {
  return license.features.flatMap((feature) => feature.packages)[0] ?? null;
}

/** Whether the page is on a phone or a tablet, where the Mentra App runs. An iPad says it is a Mac, with a touch screen. */
export function onPhone(nav: Pick<Navigator, "userAgent" | "maxTouchPoints"> | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  if (!nav) return false;
  return /Android|iPhone|iPad|iPod/i.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
}
