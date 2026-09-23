import {AppState} from "react-native"

import {engine, SETTINGS} from "@mentra/engine"
import {acsMeetingPreviewSource, setStreamPreviewHost, type MentraUIRouter} from "@mentra/engine-host-internal"
import {PREVIEW_UI_CHANNEL} from "@mentra/miniapp"

import {
  StreamPreviewCoordinator,
  type StreamPreviewFaultKind,
  type StreamPreviewNative,
} from "./StreamPreviewCoordinator"

export {STREAM_PREVIEW_BIND_TIMEOUT_MS, STREAM_PREVIEW_FAULT_KINDS} from "./StreamPreviewCoordinator"
export type {StreamPreviewFaultKind} from "./StreamPreviewCoordinator"

/** A build without the native module: every binding is unavailable, so the page sees `unsupported`. */
const unavailableNative: StreamPreviewNative = {
  bind: async () => ({installReloadRequired: false, unavailableReason: "no_native_module"}),
  prepareDocument: async () => {
    throw new Error("no_native_module")
  },
  configure: async () => {},
  start: async () => {},
  stop: async () => {},
  unbind: async () => {},
  injectFault: async () => {
    throw Object.assign(new Error("no_native_module"), {code: "diagnostics_disabled"})
  },
  setDiagnosticsEnabled: async () => {},
  addListener: () => ({remove: () => {}}),
}

/** Fault injection: debug builds, or Super Mode (the hidden developer setting) in release. */
function diagnosticsAllowed(): boolean {
  return __DEV__ || Boolean(engine.settings.get(SETTINGS.super_mode.key))
}

function loadNative(): StreamPreviewNative {
  try {
    // Required lazily: importing it on a host without the native module throws at load time.
    // Declared against the StreamPreview native contract (bind/prepareDocument take a traceId,
    // configure takes a target box, stop/unbind take a reason).
    return require("@mentra/frame-preview").FramePreviewModule as StreamPreviewNative
  } catch (error) {
    console.warn("[PREVIEW_TRACE] layer=host phase=native_module_unavailable", String(error))
    return unavailableNative
  }
}

let coordinator: StreamPreviewCoordinator | null = null
let router: MentraUIRouter | null = null

/** The Mentra App's stream-preview coordinator, created on first use. */
export function getStreamPreviewCoordinator(): StreamPreviewCoordinator {
  if (!coordinator) {
    coordinator = new StreamPreviewCoordinator({
      native: loadNative(),
      meetings: acsMeetingPreviewSource,
      diagnosticsAllowed,
      ui: {
        reply: (packageName, requestId, reply) =>
          router?.replyToWebView(packageName, PREVIEW_UI_CHANNEL, requestId, reply),
        push: (packageName, payload) => router?.pushToWebView(packageName, PREVIEW_UI_CHANNEL, payload),
      },
    })
  }
  return coordinator
}

/** Wire the coordinator into the runtime, the `_preview` channel and app lifecycle. Idempotent. */
export function installStreamPreviewCoordinator(uiRouter: MentraUIRouter): void {
  if (router === uiRouter) return
  const first = router === null
  router = uiRouter
  const instance = getStreamPreviewCoordinator()
  uiRouter.setHostChannel(PREVIEW_UI_CHANNEL, (packageName, message) =>
    instance.handleUiRequest(packageName, message.requestId, message.payload),
  )
  uiRouter.onWebViewReady((packageName) => instance.documentReady(packageName))
  if (!first) return
  setStreamPreviewHost(instance)
  instance.setAppActive(AppState.currentState === "active")
  AppState.addEventListener("change", (state) => instance.setAppActive(state === "active"))
}

/**
 * Arm a native preview fault for the gate and fault-injection runs. Rejects with a typed
 * `diagnostics_disabled` outside debug builds and Super Mode.
 */
export function injectStreamPreviewFault(kind: StreamPreviewFaultKind, ms?: number): Promise<void> {
  return getStreamPreviewCoordinator().injectFault({kind, ms})
}
