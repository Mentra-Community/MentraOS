package com.mentra.examples.android.media

import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.Surface
import java.nio.ByteBuffer
import org.freedesktop.gstreamer.GStreamer

class GStreamerWhipReceiver(
    context: Context,
    private val onStatus: (String) -> Unit,
    private val onFrame: (Bitmap) -> Unit,
) : AutoCloseable {
    @Suppress("unused")
    private var nativeCustomData: Long = 0
    private val mainHandler = Handler(Looper.getMainLooper())

    var whipUrl: String = ""
        private set

    init {
        GStreamer.init(context.applicationContext)
        nativeInit()
    }

    fun start(advertisedHost: String, publicPort: Int, backendPort: Int): String {
        val bindUri = "http://0.0.0.0:$backendPort"
        nativeStart(bindUri)
        whipUrl = "http://$advertisedHost:$publicPort/whip/endpoint"
        onStatus("Listening at $whipUrl")
        return whipUrl
    }

    fun stop() {
        nativeStop()
        whipUrl = ""
    }

    fun setSurface(surface: Surface) {
        nativeSurfaceInit(surface)
    }

    fun clearSurface() {
        nativeSurfaceFinalize()
    }

    fun onNativeStatus(message: String) {
        onStatus(message)
    }

    fun onNativeFrame(width: Int, height: Int, stride: Int, rgba: ByteArray) {
        if (width <= 0 || height <= 0 || stride < width * 4) return
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        if (stride == width * 4) {
            bitmap.copyPixelsFromBuffer(ByteBuffer.wrap(rgba))
        } else {
            val packed = ByteArray(width * height * 4)
            for (row in 0 until height) {
                System.arraycopy(rgba, row * stride, packed, row * width * 4, width * 4)
            }
            bitmap.copyPixelsFromBuffer(ByteBuffer.wrap(packed))
        }
        mainHandler.post { onFrame(bitmap) }
    }

    override fun close() {
        nativeFinalize()
    }

    private external fun nativeInit()
    private external fun nativeFinalize()
    private external fun nativeStart(bindUri: String)
    private external fun nativeStop()
    private external fun nativeSurfaceInit(surface: Any)
    private external fun nativeSurfaceFinalize()

    companion object {
        init {
            System.loadLibrary("gstreamer_android")
            System.loadLibrary("mentra_android_webrtc_receiver")
        }
    }
}
