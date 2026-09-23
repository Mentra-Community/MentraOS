package com.mentra.framepreview

import android.content.pm.ApplicationInfo
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

/**
 * Native surface of the stream preview. One consumer; the host decides who may bind.
 *
 * This module enforces the lifetimes (binding, document, production) and the build's ceilings:
 * diagnostics sources, modes and fault hooks are refused unless diagnostics are enabled, which
 * they are by default only in debuggable builds.
 */
class FramePreviewModule : Module() {
  private val port = FramePreviewPort()
  private val trace = PreviewTrace({ level, line -> emitLog(level, line) })
  private val session = FramePreviewSession(
    transport = port,
    trace = trace,
    scaler = LibyuvI420Scaler(onFallback = { reason ->
      trace.warnLimited("scaler_fallback", "scaler_fallback", mapOf("reason" to reason))
    }),
  )

  @Volatile private var boundPackage: String? = null

  @Volatile private var documentGeneration: Int? = null

  @Volatile private var documentToken: String? = null

  override fun definition() = ModuleDefinition {
    Name("MentraFramePreview")
    Events("onStatus", "onStopped", "onLog")

    OnCreate {
      val context = appContext.reactContext
      session.attachContext(context)
      val debuggable = ((context?.applicationInfo?.flags ?: 0) and ApplicationInfo.FLAG_DEBUGGABLE) != 0
      session.setDiagnosticsEnabled(debuggable)
      session.setRunLogEnabled(debuggable)
      session.onStatus = { status -> sendEvent("onStatus", status) }
      session.onStopped = { reason, docGen -> sendEvent("onStopped", mapOf("reason" to reason, "docGen" to docGen)) }
    }

    AsyncFunction("bind") { options: Map<String, Any?> ->
      val packageName = options["packageName"] as? String
        ?: throw CodedException("invalid_argument", "packageName is required", null)
      val hostViewTag = (options["hostViewTag"] as? Number)?.toInt()
        ?: throw CodedException("invalid_argument", "hostViewTag is required", null)
      (options["traceId"] as? String)?.let { trace.traceId = it }

      // React Native's WebView ref is an imperative handle, not a host component, so the tag
      // belongs to the plain View wrapping it. Walk down to the real android.webkit.WebView.
      val webView = appContext.findView<View>(hostViewTag)?.let(::findWebView)
      if (webView == null) {
        trace.warn("bind_unavailable", mapOf("reason" to "no_webview"))
        return@AsyncFunction mapOf("installReloadRequired" to false, "unavailableReason" to "no_webview")
      }
      val result = port.install(webView)
      if (!result.supported) {
        trace.warn("bind_unavailable", mapOf("reason" to result.unavailableReason, "detail" to result.detail))
        return@AsyncFunction mapOf("installReloadRequired" to false, "unavailableReason" to result.unavailableReason)
      }
      boundPackage = packageName
      trace.info("transport_bind", mapOf("transport" to "webmessage", "reloadRequired" to result.installReloadRequired))
      if (result.installReloadRequired) session.onInstallReload()
      mapOf("installReloadRequired" to result.installReloadRequired)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("prepareDocument") { options: Map<String, Any?> ->
      if (boundPackage == null) throw CodedException("not_bound", "prepareDocument before bind", null)
      (options["traceId"] as? String)?.let { trace.traceId = it }
      val docGen = (options["docGen"] as? Number)?.toInt()
        ?: throw CodedException("invalid_argument", "docGen is required", null)
      // Idempotent per document: a page that asks twice must not invalidate its own credit.
      val token = documentToken.takeIf { documentGeneration == docGen } ?: UUID.randomUUID().toString().also {
        session.prepareDocument(it, docGen)
        documentGeneration = docGen
        documentToken = it
      }
      mapOf(
        "protocolVersion" to PROTOCOL_VERSION,
        "transport" to "webmessage",
        "portName" to FramePreviewPort.PORT_NAME,
        "token" to token,
        "docGen" to docGen,
      )
    }

    AsyncFunction("configure") { options: Map<String, Any?> ->
      val config = try {
        PreviewConfig.fromMap(options)
      } catch (error: IllegalArgumentException) {
        throw CodedException("invalid_argument", error.message, null)
      }
      rejectable { session.configure(config) }
    }

    AsyncFunction("start") { session.start() }

    AsyncFunction("stop") { reason: String -> session.stop(reason) }

    AsyncFunction("unbind") { reason: String ->
      boundPackage = null
      documentGeneration = null
      documentToken = null
      session.teardown(reason)
    }

    AsyncFunction("resetStats") { session.resetStats() }

    AsyncFunction("runLogPath") { session.runLogPath }

    AsyncFunction("setDiagnosticsEnabled") { enabled: Boolean -> session.setDiagnosticsEnabled(enabled) }

    AsyncFunction("setTapTelemetry") { enabled: Boolean -> session.setTapTelemetry(enabled) }

    AsyncFunction("setRunLogEnabled") { enabled: Boolean -> session.setRunLogEnabled(enabled) }

    AsyncFunction("injectFault") { options: Map<String, Any?> ->
      val kind = PreviewFaultKind.fromWire(options["kind"] as? String)
        ?: throw CodedException("invalid_argument", "unknown fault ${options["kind"]}", null)
      rejectable { session.injectFault(kind, (options["ms"] as? Number)?.toInt() ?: 0) }
    }

    OnDestroy { session.close() }
  }

  private fun rejectable(block: () -> Unit) {
    try {
      block()
    } catch (rejection: PreviewRejection) {
      throw CodedException(rejection.code, rejection.message, null)
    }
  }

  private fun emitLog(level: PreviewTrace.Level, line: String) {
    if (level == PreviewTrace.Level.WARN) Log.w(TAG, line) else Log.i(TAG, line)
    try {
      sendEvent("onLog", mapOf("level" to level.wire, "message" to line))
    } catch (ignored: Throwable) {
      // Before the JS runtime is ready there is nobody to tell; logcat still has it.
    }
  }

  /**
   * Depth-first search rather than a cast to the library's wrapper type: this module does not
   * depend on react-native-webview, and any `android.webkit.WebView` under the host view is the
   * one the miniapp is rendering into.
   */
  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view !is ViewGroup) return null
    for (index in 0 until view.childCount) {
      findWebView(view.getChildAt(index))?.let { return it }
    }
    return null
  }

  private companion object {
    const val TAG = "FRAME-PREVIEW"
    const val PROTOCOL_VERSION = 1
  }
}
