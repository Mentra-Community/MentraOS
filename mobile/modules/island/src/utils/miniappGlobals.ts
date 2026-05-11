/**
 * miniappGlobals — shared builder for the window.MentraOS globals injected
 * into every miniapp WebView (both cloud and local).
 *
 * Authors should be able to use one API in their miniapp code regardless of
 * whether it's hosted in the cloud or on-device. So both injection paths
 * (webview.tsx for cloud miniapps, MiniappHost.tsx for local miniapps) funnel
 * through this util.
 */

import {Dimensions, Platform} from "react-native"

export interface MiniappSafeArea {
  top: number
  bottom: number
  left: number
  right: number
}

export interface CapsuleMenuRect {
  top: number
  right: number
  bottom: number
  left: number
  width: number
  height: number
}

/**
 * The capsule menu bounding rect in the WebView's own coordinate space.
 *
 * Keep in sync with CapsuleMenu.tsx:
 *   - CapsuleButton height ≈ h-7.5 (30px), width ≈ 73px
 *   - Positioned at right-2 (8px), top = theme.spacing.s2 (8px) below insets.top
 */
const CAPSULE_MENU_HEIGHT = 30
const CAPSULE_MENU_WIDTH = 73
const CAPSULE_MENU_PADDING = 8

/**
 * @param topInsetOffset  extra top offset to add when the WebView container does
 *   NOT already pad by the safe-area inset (i.e. WebView fills edge-to-edge under
 *   the status bar). Pass `insets.top` in that case, or 0 when the container
 *   already applies top padding.
 */
export function getCapsuleMenuRect(topInsetOffset = 0): CapsuleMenuRect {
  const screenWidth = Dimensions.get("window").width
  const top = topInsetOffset + CAPSULE_MENU_PADDING
  return {
    top,
    right: CAPSULE_MENU_PADDING,
    bottom: top + CAPSULE_MENU_HEIGHT,
    left: screenWidth - CAPSULE_MENU_PADDING - CAPSULE_MENU_WIDTH,
    width: CAPSULE_MENU_WIDTH,
    height: CAPSULE_MENU_HEIGHT,
  }
}

export type MiniappColorScheme = "light" | "dark"

export interface BuildMiniappGlobalsOptions {
  packageName?: string
  capabilities?: string[]
  miniappLocal?: boolean
  miniappDeveloperMode?: boolean
  safeAreaInsets: MiniappSafeArea
  /**
   * True when the WebView container renders edge-to-edge (no top padding for
   * the status bar). In that case the capsule menu rect needs to shift down by
   * the top inset so its coords match where it's actually drawn on screen.
   */
  webviewFillsStatusBar?: boolean
  /** Current host color scheme. Miniapps may follow this to match the phone. */
  colorScheme?: MiniappColorScheme
}

/**
 * Returns the JS string to inject into a miniapp WebView before its content
 * loads. Sets window.MentraOS with the standard fields miniapps read:
 *
 *   window.MentraOS = {
 *     platform, packageName?, capabilities, safeAreaInsets, capsuleMenu,
 *     miniappLocal?, miniappDeveloperMode?
 *   }
 *
 * Also defines a stub window.receiveNativeMessage so the miniapp can safely
 * assign to it before the native bridge wires in.
 */
export function buildMiniappGlobalsScript(opts: BuildMiniappGlobalsOptions): string {
  const capsuleTopOffset = opts.webviewFillsStatusBar ? opts.safeAreaInsets.top : 0
  const globals: Record<string, unknown> = {
    platform: Platform.OS,
    capabilities: opts.capabilities ?? ["share", "open_url", "copy_clipboard", "download"],
    safeAreaInsets: opts.safeAreaInsets,
    capsuleMenu: getCapsuleMenuRect(capsuleTopOffset),
  }
  if (opts.packageName) globals.packageName = opts.packageName
  if (opts.miniappLocal) globals.miniappLocal = true
  if (opts.miniappDeveloperMode) globals.miniappDeveloperMode = true
  if (opts.colorScheme) globals.colorScheme = opts.colorScheme

  // CSS custom properties that mirror the capsule menu / safe-area data.
  // Miniapp CSS (or Tailwind arbitrary values) can read these without
  // touching JS: e.g. `style="margin-top: var(--mentra-capsule-top)"`.
  const capsule = globals.capsuleMenu as CapsuleMenuRect
  const insets = opts.safeAreaInsets
  const capsuleCenter = capsule.top + capsule.height / 2
  const cssVars: Record<string, string> = {
    "--mentra-safe-top": `${insets.top}px`,
    "--mentra-safe-bottom": `${insets.bottom}px`,
    "--mentra-safe-left": `${insets.left}px`,
    "--mentra-safe-right": `${insets.right}px`,
    "--mentra-capsule-top": `${capsule.top}px`,
    "--mentra-capsule-bottom": `${capsule.bottom}px`,
    "--mentra-capsule-left": `${capsule.left}px`,
    "--mentra-capsule-right": `${capsule.right}px`,
    "--mentra-capsule-width": `${capsule.width}px`,
    "--mentra-capsule-height": `${capsule.height}px`,
    "--mentra-capsule-center-y": `${capsuleCenter}px`,
    // Right-side gutter to reserve so content doesn't slide under the
    // capsule: capsule width + 16px breathing room.
    "--mentra-capsule-gutter": `${capsule.width + 16}px`,
  }
  const cssVarsBlock = Object.entries(cssVars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ")

  // Console-tap shim: wrap console.log/warn/error/info/debug so each call
  // also forwards a `dev_log` envelope back to the phone via
  // ReactNativeWebView.postMessage. Dev mode forwards to the laptop's
  // `mentra-miniapp dev` terminal; non-dev mode falls back to the React
  // Native log stream (Metro / Xcode console / adb logcat) so installed-
  // miniapp errors are still inspectable when there's no laptop sidecar.
  //
  // Also tap window.onerror and window.onunhandledrejection so synchronous
  // throws and unhandled promise rejections surface even when the bundle
  // never gets a chance to call console.error itself.
  const consoleTapBlock = `
    (function() {
      try {
        var levels = ["log", "warn", "error", "info", "debug"];
        var seen = new WeakSet();
        function safeSerialize(arg) {
          if (arg instanceof Error) return {__error: true, message: arg.message, stack: arg.stack};
          if (arg === null || typeof arg !== "object") return arg;
          try {
            return JSON.parse(JSON.stringify(arg, function(k, v) {
              if (v !== null && typeof v === "object") {
                if (seen.has(v)) return "[Circular]";
                seen.add(v);
              }
              return v;
            }));
          } catch (e) {
            try { return String(arg); } catch (_) { return "[unserializable]"; }
          }
        }
        levels.forEach(function(level) {
          var original = console[level];
          if (typeof original !== "function") return;
          console[level] = function() {
            try { original.apply(console, arguments); } catch (_) {}
            try {
              var args = Array.prototype.slice.call(arguments).map(safeSerialize);
              if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === "function") {
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  payload: {
                    type: "dev_log",
                    level: level,
                    args: args,
                    packageName: (window.MentraOS && window.MentraOS.packageName) || null,
                    timestamp: Date.now()
                  }
                }));
              }
            } catch (_) { /* swallow */ }
          };
        });
      } catch (_) { /* ignore */ }

      // Surface synchronous errors and unhandled promise rejections via the
      // same dev_log channel — many bundle-startup crashes never get to call
      // console.error themselves.
      try {
        window.addEventListener("error", function(e) {
          try {
            if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === "function") {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                payload: {
                  type: "dev_log",
                  level: "error",
                  args: ["[window.error] " + (e.message || "unknown"), {filename: e.filename, lineno: e.lineno, colno: e.colno, stack: e.error && e.error.stack}],
                  packageName: (window.MentraOS && window.MentraOS.packageName) || null,
                  timestamp: Date.now()
                }
              }));
            }
          } catch (_) {}
        });
        window.addEventListener("unhandledrejection", function(e) {
          try {
            if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === "function") {
              var reason = e.reason;
              var serialized = reason instanceof Error
                ? {__error: true, message: reason.message, stack: reason.stack}
                : (typeof reason === "object" ? JSON.stringify(reason) : String(reason));
              window.ReactNativeWebView.postMessage(JSON.stringify({
                payload: {
                  type: "dev_log",
                  level: "error",
                  args: ["[unhandledrejection]", serialized],
                  packageName: (window.MentraOS && window.MentraOS.packageName) || null,
                  timestamp: Date.now()
                }
              }));
            }
          } catch (_) {}
        });
      } catch (_) {}
    })();
  `

  // Lock zoom so miniapps feel like apps, not pages: force a non-scalable
  // viewport meta (overriding whatever the miniapp shipped) and disable
  // double-tap-zoom via CSS. Re-applies on DOMContentLoaded in case the
  // miniapp re-writes <head> during boot.
  return `
    window.MentraOS = ${JSON.stringify(globals)};
    window.receiveNativeMessage = window.receiveNativeMessage || function() {};
    (function() {
      try {
        var styleEl = document.createElement("style");
        styleEl.setAttribute("data-mentra-injected", "1");
        styleEl.textContent =
          ":root { ${cssVarsBlock} }" +
          "html, body { touch-action: manipulation; -ms-content-zooming: none; }";
        (document.head || document.documentElement).appendChild(styleEl);
      } catch (e) { /* ignore */ }

      function lockViewport() {
        try {
          var content = "width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover";
          var existing = document.querySelector('meta[name="viewport"]');
          if (existing) {
            existing.setAttribute("content", content);
          } else {
            var meta = document.createElement("meta");
            meta.setAttribute("name", "viewport");
            meta.setAttribute("content", content);
            (document.head || document.documentElement).appendChild(meta);
          }
        } catch (e) { /* ignore */ }
      }
      lockViewport();
      document.addEventListener("DOMContentLoaded", lockViewport);
    })();
    ${consoleTapBlock}
    true;
  `
}
