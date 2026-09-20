package com.mentra.framepreview

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

/**
 * Experiment surface for the raw-frame preview. One consumer, host-gated.
 *
 * The host decides who may bind (the Mentra Call miniapp, in a development build); this module
 * only enforces that there is exactly one subscription and that its lifetime is explicit.
 */
class FramePreviewModule : Module() {
  private val session = FramePreviewSession()

  @Volatile private var boundPackage: String? = null

  override fun definition() = ModuleDefinition {
    Name("MentraFramePreview")
    Events("onStatus", "onStopped")

    OnCreate {
      session.onStatus = { status -> sendEvent("onStatus", status) }
      session.onStopped = { reason -> sendEvent("onStopped", mapOf("reason" to reason)) }
    }

    AsyncFunction("bind") { options: Map<String, Any?> ->
      val packageName = options["packageName"] as? String
        ?: throw IllegalArgumentException("packageName is required")
      val hostViewTag = (options["hostViewTag"] as? Number)?.toInt()
        ?: throw IllegalArgumentException("hostViewTag is required")

      // React Native's WebView ref is an imperative handle, not a host component, so the tag
      // the host can actually give us belongs to the plain View wrapping it. Walk down from
      // there to the real android.webkit.WebView.
      val host = appContext.findView<View>(hostViewTag)
      val webView = host?.let(::findWebView)
      if (webView == null) {
        return@AsyncFunction mapOf(
          "supported" to false,
          "transport" to "webmessage",
          "unavailableReason" to "webview_not_found",
          "listenerInstalled" to false,
          "installReloadRequired" to false,
        )
      }

      boundPackage = packageName
      val result = session.port.install(webView)
      mapOf(
        "supported" to result.supported,
        "transport" to "webmessage",
        "unavailableReason" to result.unavailableReason,
        "listenerInstalled" to result.listenerInstalled,
        "installReloadRequired" to result.installReloadRequired,
      )
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("prepareDocument") { options: Map<String, Any?> ->
      if (boundPackage == null) throw IllegalStateException("prepareDocument before bind")
      val token = UUID.randomUUID().toString()
      val sessionGeneration = session.prepareDocument(token)
      mapOf(
        "transport" to "webmessage",
        "token" to token,
        "supported" to true,
        "sessionGen" to sessionGeneration,
        "docGen" to ((options["docGen"] as? Number)?.toInt() ?: 0),
      )
    }

    AsyncFunction("configure") { options: Map<String, Any?> ->
      session.configure(
        source = options["source"] as? String,
        mode = options["mode"] as? String,
        targetFps = (options["targetFps"] as? Number)?.toInt(),
        width = (options["width"] as? Number)?.toInt(),
        height = (options["height"] as? Number)?.toInt(),
        consumerDelayMs = (options["consumerDelayMs"] as? Number)?.toInt(),
      )
    }

    AsyncFunction("start") { session.start() }

    AsyncFunction("stop") { reason: String? -> session.stop(reason ?: "host") }

    AsyncFunction("resetStats") { session.resetStats() }

    AsyncFunction("unbind") {
      boundPackage = null
      session.teardown("unbind")
    }

    OnDestroy { session.teardown("destroy") }
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
}
