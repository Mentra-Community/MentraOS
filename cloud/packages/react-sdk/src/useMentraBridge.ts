// react-sdk/src/useMentraBridge.ts

declare global {
  interface Window {
    MentraOS?: {
      platform: string;
      capabilities: string[];
    };
    ReactNativeWebView?: {
      postMessage: (message: string) => void;
    };
    receiveNativeMessage?: (message: any) => void;
  }
}

interface ShareOptions {
  /** Plain text to share */
  text?: string;
  /** Title shown in the share sheet */
  title?: string;
  /** Base64-encoded file data (for PDFs, images, etc.) */
  base64?: string;
  /** MIME type when sharing a file (e.g. 'application/pdf', 'image/png') */
  mimeType?: string;
  /** Filename when sharing a file */
  filename?: string;
  /** URL to share */
  url?: string;
}

interface DownloadOptions {
  /** Base64-encoded file data */
  base64?: string;
  /** URL to download from */
  url?: string;
  /** MIME type of the file */
  mimeType?: string;
  /** Filename for the downloaded file */
  filename: string;
}

interface BridgeResponse {
  success: boolean;
  cancelled?: boolean;
  error?: string;
  filePath?: string;
}

type ResponseCallback = (response: BridgeResponse) => void;

const pendingRequests = new Map<string, ResponseCallback>();
let listenerSetUp = false;

function generateRequestId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function setupResponseListener() {
  if (listenerSetUp) return;
  listenerSetUp = true;

  const originalHandler = window.receiveNativeMessage;
  window.receiveNativeMessage = (message: any) => {
    if (message?.type === "bridge_response" && message?.payload?.requestId) {
      const callback = pendingRequests.get(message.payload.requestId);
      if (callback) {
        pendingRequests.delete(message.payload.requestId);
        const { requestId: _requestId, ...result } = message.payload;
        callback(result as BridgeResponse);
        return;
      }
    }
    // Pass through to any existing handler
    if (originalHandler) {
      originalHandler(message);
    }
  };
}

function sendBridgeMessage(type: string, payload: any, onResponse?: ResponseCallback): void {
  if (!window.ReactNativeWebView) return;

  const requestId = onResponse ? generateRequestId() : undefined;
  if (requestId && onResponse) {
    setupResponseListener();
    pendingRequests.set(requestId, onResponse);
  }

  window.ReactNativeWebView.postMessage(
    JSON.stringify({
      type,
      payload,
      requestId,
      timestamp: Date.now(),
    }),
  );
}

/**
 * Check if the current page is running inside the MentraOS app webview.
 */
export function isInMentraOS(): boolean {
  return typeof window !== "undefined" && !!window.MentraOS;
}

/**
 * Get the current platform ('ios' | 'android') if running in MentraOS, or null.
 */
export function getMentraOSPlatform(): string | null {
  return window.MentraOS?.platform ?? null;
}

/**
 * Check if a specific bridge capability is available.
 */
export function hasCapability(capability: string): boolean {
  return window.MentraOS?.capabilities?.includes(capability) ?? false;
}

/**
 * Open a URL in the system browser (escaping the webview).
 * Falls back to window.open() in a regular browser.
 */
export function openUrl(url: string): void {
  if (isInMentraOS()) {
    sendBridgeMessage("open_url", { url });
  } else {
    window.open(url, "_blank");
  }
}

/**
 * Copy text to the system clipboard.
 * Falls back to navigator.clipboard in a regular browser.
 * Returns a promise that resolves when the copy completes.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (isInMentraOS()) {
    return new Promise((resolve) => {
      sendBridgeMessage("copy_clipboard", { text }, (response) => {
        resolve(response.success);
      });
      // Timeout fallback in case native side doesn't respond
      setTimeout(() => resolve(true), 2000);
    });
  }

  // Browser fallback
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the native share sheet.
 *
 * Supports text, URLs, and files (via base64).
 * Falls back to navigator.share() -> clipboard copy in a regular browser.
 *
 * @example
 * // Share text
 * share({ text: 'Check this out!' });
 *
 * // Share a PDF
 * share({ base64: pdfBase64, mimeType: 'application/pdf', filename: 'notes.pdf' });
 *
 * // Share a URL
 * share({ url: 'https://example.com', title: 'Example' });
 */
export async function share(options: ShareOptions): Promise<BridgeResponse> {
  if (isInMentraOS()) {
    return new Promise((resolve) => {
      sendBridgeMessage("share", options, (response) => {
        resolve(response);
      });
      // Timeout — share sheet might take a while, but don't hang forever
      setTimeout(() => resolve({ success: true }), 30000);
    });
  }

  // Browser fallback chain: navigator.share -> clipboard
  if (typeof navigator !== "undefined" && navigator.share && !options.base64) {
    try {
      await navigator.share({
        title: options.title,
        text: options.text,
        url: options.url,
      });
      return { success: true };
    } catch (e: any) {
      if (e.name === "AbortError") {
        return { success: false, cancelled: true };
      }
      // Fall through to clipboard
    }
  }

  // Last resort: copy to clipboard
  const textToCopy = options.text || options.url || "";
  if (textToCopy) {
    const copied = await copyToClipboard(textToCopy);
    return { success: copied, error: copied ? undefined : "Failed to copy to clipboard" };
  }

  return { success: false, error: "Nothing to share" };
}

/**
 * Download a file. In MentraOS, this writes the file and opens the share sheet
 * so the user can save it. In a regular browser, triggers a download.
 *
 * @example
 * // Download from base64
 * download({ base64: pdfBase64, mimeType: 'application/pdf', filename: 'report.pdf' });
 *
 * // Download from URL
 * download({ url: 'https://example.com/file.pdf', filename: 'file.pdf' });
 */
export async function download(options: DownloadOptions): Promise<BridgeResponse> {
  if (isInMentraOS()) {
    return new Promise((resolve) => {
      sendBridgeMessage("download", options, (response) => {
        resolve(response);
      });
      setTimeout(() => resolve({ success: true }), 60000);
    });
  }

  // Browser fallback: create a download link
  try {
    const a = document.createElement("a");
    if (options.base64 && options.mimeType) {
      a.href = `data:${options.mimeType};base64,${options.base64}`;
    } else if (options.url) {
      a.href = options.url;
    } else {
      return { success: false, error: "Nothing to download" };
    }
    a.download = options.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * React hook for MentraOS bridge capabilities.
 *
 * @example
 * ```tsx
 * import { useMentraBridge } from '@mentra/react';
 *
 * function MyComponent() {
 *   const bridge = useMentraBridge();
 *
 *   return (
 *     <button onClick={() => bridge.share({ text: 'Hello!' })}>
 *       Share
 *     </button>
 *   );
 * }
 * ```
 */
export function useMentraBridge() {
  return {
    isInMentraOS: isInMentraOS(),
    platform: getMentraOSPlatform(),
    hasCapability,
    share,
    openUrl,
    copyToClipboard,
    download,
  };
}
