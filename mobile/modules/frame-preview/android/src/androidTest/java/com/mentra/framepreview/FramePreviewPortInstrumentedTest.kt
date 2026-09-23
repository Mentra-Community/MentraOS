package com.mentra.framepreview

import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewFeature
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A real WebView on a device or emulator: the listener is installed before the first navigation,
 * the page authenticates with the document token, a binary MFPV frame arrives as an ArrayBuffer,
 * and the page's `ack(gen, seq)` comes back. No reload is ever needed.
 */
@RunWith(AndroidJUnit4::class)
class FramePreviewPortInstrumentedTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()

  private val page = """
    <!doctype html><html><body><script>
      const port = window.${FramePreviewPort.PORT_NAME};
      port.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const view = new DataView(event.data);
        const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        if (magic !== "MFPV") return;
        port.postMessage(JSON.stringify({t: "ack", gen: view.getUint32(12, true), seq: view.getUint32(16, true)}));
      };
      port.postMessage(JSON.stringify({t: "hello", token: "wrong-token"}));
      port.postMessage(JSON.stringify({t: "hello", token: "document-token"}));
    </script></body></html>
  """.trimIndent()

  @Test
  fun framesAndAcksRoundTripWithNoInstallReload() {
    assumeTrue(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
    assumeTrue(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER))

    val port = FramePreviewPort()
    val authenticated = CountDownLatch(1)
    val acked = CountDownLatch(1)
    val ack = AtomicReference<Pair<Int, Int>>()
    val rejections = AtomicInteger()
    val installReloads = AtomicInteger()
    port.onAuthenticated = { authenticated.countDown() }
    port.onAck = { gen, seq ->
      ack.set(gen to seq)
      acked.countDown()
    }
    port.onFailure = { reason, _ -> if (reason == "auth_failed") rejections.incrementAndGet() }

    val webView = AtomicReference<WebView>()
    instrumentation.runOnMainSync {
      val view = WebView(instrumentation.targetContext)
      view.settings.javaScriptEnabled = true
      webView.set(view)
      port.rotateToken("document-token")
      // Before navigation: this is the ordering the host guarantees.
      val result = port.install(view)
      assertTrue(result.supported)
      assertFalse(result.installReloadRequired)
      if (result.installReloadRequired) installReloads.incrementAndGet()
      view.loadDataWithBaseURL("https://preview.local/", page, "text/html", "utf-8", null)
    }

    assertTrue("page authenticated", authenticated.await(10, TimeUnit.SECONDS))
    assertEquals(1, rejections.get())

    val bytes = ByteArray(PreviewFrameHeader.BYTE_COUNT + PreviewPixelFormat.I420.packedSize(4, 2))
    PreviewFrameHeader(
      payloadLength = PreviewPixelFormat.I420.packedSize(4, 2),
      sessionGeneration = 5,
      frameSequence = 9,
      width = 4,
      height = 2,
      pixelFormat = PreviewPixelFormat.I420,
    ).writeInto(bytes)
    assertTrue(port.send(bytes) { _, _ -> })

    assertTrue("page acknowledged", acked.await(10, TimeUnit.SECONDS))
    assertEquals(5 to 9, ack.get())
    assertEquals(0, installReloads.get())

    instrumentation.runOnMainSync {
      port.destroy()
      webView.get().destroy()
    }
  }
}
