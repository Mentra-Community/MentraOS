import {redactSecrets} from "@mentra/engine-host-internal"
import type {WebViewProps} from "react-native-webview"

type WebViewError = Parameters<NonNullable<WebViewProps["onError"]>>[0]["nativeEvent"]

const MAX_ERROR_TEXT_LENGTH = 512

function safeErrorText(value: string): string {
  const text = value
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|(?:data|about|blob):)\S*/gi, "[REDACTED]")
    .replace(/[?#]\S*/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
  // Normalize credential-label separators for the existing conservative redactor.
  if (redactSecrets(text.replace(/[_-]/g, " ")) === "[REDACTED]") return "[REDACTED]"
  return text.slice(0, MAX_ERROR_TEXT_LENGTH)
}

/** Keep the native cause without logging the WebView's URL, title or request details. */
export function getWebViewLoadErrorDiagnostics(error: Pick<WebViewError, "domain" | "code" | "description">) {
  return {
    domain: typeof error.domain === "string" ? safeErrorText(error.domain) : undefined,
    code: Number.isFinite(error.code) ? error.code : undefined,
    description: typeof error.description === "string" ? safeErrorText(error.description) : undefined,
  }
}
