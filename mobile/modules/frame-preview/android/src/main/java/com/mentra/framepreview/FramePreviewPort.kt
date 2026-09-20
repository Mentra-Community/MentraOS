package com.mentra.framepreview

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * Binary channel into the miniapp WebView on Android.
 *
 * Chromium can hand a page an `ArrayBuffer` directly through a `WebMessageListener` reply proxy,
 * which is why Android needs no socket: the bytes go straight from native to the page with no
 * JSON, no base64, and no trip through React Native's bridge.
 *
 * Two lifetimes are kept apart here, and conflating them is the bug this class exists to avoid:
 *
 *  - The **listener** belongs to the native `WebView` and is installed exactly once. It cannot
 *    be added to a document that has already loaded, so the first install may require one
 *    reload; re-binding later must not ask for another.
 *  - The **consumer** belongs to one document. A navigation or reload mints a new token, drops
 *    the old reply proxy, and revokes credit, so a page that is on its way out cannot keep
 *    receiving frames.
 */
class FramePreviewPort {
  data class InstallResult(
    val supported: Boolean,
    val unavailableReason: String?,
    val listenerInstalled: Boolean,
    val installReloadRequired: Boolean,
  )

  var onAuthenticated: (() -> Unit)? = null
  var onAck: ((Int, Int) -> Unit)? = null
  var onFailure: ((String, String) -> Unit)? = null

  private val main = Handler(Looper.getMainLooper())

  @Volatile private var webView: WebView? = null

  @Volatile private var replyProxy: JavaScriptReplyProxy? = null

  @Volatile private var token: String = ""

  @Volatile private var listenerInstalled = false

  /**
   * Install the listener on [target] if it is not already there. Must be called on the UI thread.
   */
  fun install(target: WebView): InstallResult {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      return InstallResult(false, "web_message_listener_unsupported", false, false)
    }
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)) {
      // Without binary payloads the only alternative is base64 over the JSON bridge, which is
      // the thing this experiment exists to avoid. Report it rather than silently degrade.
      return InstallResult(false, "web_message_array_buffer_unsupported", false, false)
    }
    if (webView === target && listenerInstalled) {
      return InstallResult(true, null, true, false)
    }
    if (webView !== target) {
      removeListener()
      webView = target
    }

    return try {
      WebViewCompat.addWebMessageListener(target, PORT_NAME, setOf("*"), listener)
      listenerInstalled = true
      // A listener registered after the document loaded does not exist inside that document.
      // One reload fixes it; the identity check above stops this from repeating.
      val needsReload = target.url != null
      Log.i(TAG, "port installed reloadRequired=$needsReload url=${target.url}")
      InstallResult(true, null, true, needsReload)
    } catch (error: Throwable) {
      Log.w(TAG, "addWebMessageListener failed", error)
      InstallResult(false, "listener_install_failed", false, false)
    }
  }

  /**
   * A new document invalidates the old page's credential and its reply proxy. The listener stays.
   */
  fun rotateToken(token: String) {
    this.token = token
    replyProxy = null
  }

  /** Send one frame. False when there is no authenticated consumer for the current document. */
  fun send(bytes: ByteArray, onSendMeasured: (Long) -> Unit): Boolean {
    val proxy = replyProxy ?: return false
    // postMessage must run on the thread that owns the WebView. Packing already happened on the
    // worker; only this hop is on the UI thread, and it is timed because "does this block the
    // UI" is one of the questions the experiment has to answer.
    main.post {
      val started = System.nanoTime()
      try {
        proxy.postMessage(bytes)
      } catch (error: Throwable) {
        Log.w(TAG, "postMessage(byte[]) failed", error)
        onFailure?.invoke("send_failed", error.message ?: error.toString())
      }
      onSendMeasured(System.nanoTime() - started)
    }
    return true
  }

  fun isAuthenticated(): Boolean = replyProxy != null

  fun destroy() {
    replyProxy = null
    token = ""
    removeListener()
    webView = null
  }

  private fun removeListener() {
    val target = webView ?: return
    if (!listenerInstalled) return
    listenerInstalled = false
    val remove = Runnable {
      try {
        WebViewCompat.removeWebMessageListener(target, PORT_NAME)
      } catch (error: Throwable) {
        Log.w(TAG, "removeWebMessageListener failed", error)
      }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) remove.run() else main.post(remove)
  }

  private val listener = WebViewCompat.WebMessageListener {
      view: WebView,
      message: WebMessageCompat,
      _: Uri,
      isMainFrame: Boolean,
      proxy: JavaScriptReplyProxy,
    ->
    // Origin is not the check. A `file://` page reports origin "null", and an iframe can claim a
    // plausible one, so identity of the WebView plus the per-document token is what decides.
    if (!isMainFrame || view !== webView) return@WebMessageListener
    val text = message.data ?: return@WebMessageListener
    handle(text, proxy)
  }

  private fun handle(text: String, proxy: JavaScriptReplyProxy) {
    val json = try {
      JSONObject(text)
    } catch (error: Throwable) {
      return
    }
    when (json.optString("t")) {
      "hello" -> {
        val supplied = json.optString("token")
        if (token.isEmpty() || supplied != token) {
          Log.w(TAG, "hello rejected: token mismatch")
          onFailure?.invoke("auth_failed", "token mismatch")
          return
        }
        replyProxy = proxy
        Log.i(TAG, "consumer authenticated")
        onAuthenticated?.invoke()
      }
      "ack" -> onAck?.invoke(json.optInt("gen", -1), json.optInt("seq", -1))
    }
  }

  companion object {
    private const val TAG = "FRAME-PREVIEW"

    /** Injected into the page as `window.MentraFramePreviewPort`. */
    const val PORT_NAME = "MentraFramePreviewPort"
  }
}
