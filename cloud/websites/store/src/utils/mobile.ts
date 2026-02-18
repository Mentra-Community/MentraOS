/**
 * Mobile detection and deeplink utilities for the MentraOS app store
 */

/**
 * Detects if the user is on a mobile device
 */
export function isMobileDevice(): boolean {
  const userAgent =
    navigator.userAgent || navigator.vendor || (window as any).opera;

  // Check for mobile user agents
  return /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
    userAgent.toLowerCase(),
  );
}

/**
 * Detects if the user is on an Android device
 */
export function isAndroid(): boolean {
  const userAgent = navigator.userAgent || navigator.vendor;
  return /android/i.test(userAgent);
}

/**
 * Detects if the user is on an iOS device
 */
export function isIOS(): boolean {
  const userAgent = navigator.userAgent || navigator.vendor;
  return (
    /iphone|ipad|ipod/i.test(userAgent.toLowerCase()) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  ); // iPad detection
}

/**
 * Detects if the user is on macOS (desktop)
 */
export function isMacOS(): boolean {
  const userAgent = navigator.userAgent || navigator.vendor;
  const platform = navigator.platform;
  return /mac/i.test(platform) || /mac/i.test(userAgent);
}

/**
 * Generates a deeplink URL for opening the MentraOS app
 * @param packageName - Optional package name to navigate to a specific app
 * @returns The deeplink URL
 */
export function generateDeeplink(packageName?: string): string {
  const baseUrl = "https://apps.mentra.glass";

  if (packageName) {
    // Return the web URL that will be handled by app links/universal links
    return `${baseUrl}/package/${packageName}`;
  }

  return baseUrl;
}

/**
 * Attempts to open the MentraOS app with a deeplink
 * Falls back to web if the app is not installed
 * @param packageName - Optional package name to navigate to a specific app
 */
export function openInApp(packageName?: string): void {
  const deeplink = generateDeeplink(packageName);

  if (isMobileDevice()) {
    // For mobile devices, just navigate to the URL
    // The OS will handle opening the app if it's installed
    window.location.href = deeplink;
  }
}

/**
 * Opens the appropriate app store for downloading MentraOS
 * - iOS devices (iPhone, iPad) → App Store
 * - Android devices → Play Store
 * - All desktop/laptop devices → mentra.glass/os
 */
export function openAppStore(): void {
  if (isIOS()) {
    // iOS devices (iPhone, iPad, iPod)
    window.open(
      "https://apps.apple.com/us/app/mentra-the-smart-glasses-app/id6747363193",
      "_blank",
    );
  } else if (isAndroid()) {
    // Android devices
    window.open(
      "https://play.google.com/store/apps/details?id=com.mentra.mentra",
      "_blank",
    );
  } else {
    // All desktop/laptop devices (macOS, Windows, Linux, etc.)
    window.open("https://mentra.glass/os", "_blank");
  }
}
