package com.mentra.bluetoothsdk.sgcs

import android.graphics.Bitmap
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import java.io.ByteArrayOutputStream
import java.util.Base64
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NimoBitmapAcceptanceTest {
    private lateinit var nimo: Nimo

    @Before fun setup() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        nimo = Nimo()
    }

    @After fun dispose() { nimo.cleanup() }

    @Test fun malformedInputsAreRejectedBeforeReturning() {
        val invalid = listOf(
            "not base64!",
            "data:image/jpeg;base64,${png()}",
            "data:image/bmp;base64,${png()}",
            Base64.getEncoder().encodeToString(byteArrayOf(0x89.toByte(), 80, 78, 71, 13, 10, 26, 10) + ByteArray(40)),
            Base64.getEncoder().encodeToString(byteArrayOf(66, 77) + ByteArray(60)),
            "A".repeat(NimoCanvasCodec.MAX_IMAGE_BASE64_CHARS + 1)
        )
        for (input in invalid) {
            assertFalse("Malformed bitmap was accepted: ${input.take(50)}", nimo.displayBitmap(input))
        }
    }

    @Test fun validPngAcceptsNullableGeometryAndRejectsOutOfBoundsGeometry() {
        val image = png()
        assertTrue(nimo.displayBitmap(image))
        assertTrue(nimo.displayBitmap(image, 499, 219, null, null))
        assertFalse(nimo.displayBitmap(image, 500, 0, null, null))
        assertFalse(nimo.displayBitmap(image, 0, 0, 0, 1))
        assertFalse(nimo.displayBitmap(image, -1, 0, 10, 10))
    }

    @Test fun sourceRasterBudgetsRejectOversizeAndAcceptBoundaries() {
        for ((width, height) in listOf(4097 to 1, 1 to 4097, 2049 to 2000)) {
            assertFalse("Oversize source $width x $height", nimo.displayBitmap(png(width, height)))
        }
        for ((width, height) in listOf(4096 to 1, 1 to 4096, 2000 to 2000)) {
            assertTrue("Valid boundary $width x $height", nimo.displayBitmap(png(width, height)))
        }
    }

    @Test fun coloredRasterQuantizationMatchesIosAtEveryTwoBitBoundary() {
        // Identical opaque 8x1 24-bit BMP in NimoCanvasSceneTests; no scaling.
        val bmp = byteArrayOf(
            66, 77, 78, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0,
            40, 0, 0, 0, 8, 0, 0, 0, 1, 0, 0, 0, 1, 0, 24, 0,
            0, 0, 0, 0, 24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 72, 0, 0, 73, 0, 0, 217.toByte(), 0, 0, 218.toByte(), 0,
            0, 231.toByte(), 255.toByte(), 0, 232.toByte(), 255.toByte(), 0, 0, 0, -1, -1, -1
        )
        val decode = Nimo::class.java.getDeclaredMethod(
            "decodeCanvasImage", String::class.java, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType
        ).apply { isAccessible = true }
        val gray = decode.invoke(nimo, Base64.getEncoder().encodeToString(bmp), 8, 1) as ByteArray
        assertArrayEquals(byteArrayOf(42, 43, 127, 128.toByte(), 212.toByte(), 213.toByte(), 0, -1), gray)
        assertArrayEquals(byteArrayOf(0xE9.toByte(), 0x4C), NimoCanvasCodec.pack2(gray))
    }

    private fun png(width: Int = 2, height: Int = 2): String {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        return try {
            val bytes = ByteArrayOutputStream()
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes))
            Base64.getEncoder().encodeToString(bytes.toByteArray())
        } finally { bitmap.recycle() }
    }
}
