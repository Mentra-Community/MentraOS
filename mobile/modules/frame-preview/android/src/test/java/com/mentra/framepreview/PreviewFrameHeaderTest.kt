package com.mentra.framepreview

import com.mentra.glassesmedia.video.I420Packer
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class PreviewFrameHeaderTest {
  /**
   * Golden bytes. Swift writes the same 64 bytes and TypeScript parses them; if any of the three
   * drifts, exactly one of these three tests fails and names the offset.
   */
  @Test
  fun `header golden bytes`() {
    val bytes = ByteArray(PreviewFrameHeader.BYTE_COUNT)
    PreviewFrameHeader(
      payloadLength = 1_382_400,
      sessionGeneration = 7,
      frameSequence = 258,
      width = 1280,
      height = 720,
      pixelFormat = PreviewPixelFormat.NV12,
      rotation = 1,
      colorMatrix = PreviewColorMatrix.BT709,
      colorRange = PreviewColorRange.FULL,
      flags = PreviewFrameHeader.FLAG_COLOR_METADATA_FALLBACK,
      timestampNs = 0x0102_0304_0506_0708L,
      sentAtNs = 0x1112_1314_1516_1718L,
    ).writeInto(bytes)

    assertThat(bytes.copyOfRange(0, 4)).containsExactly(0x4D, 0x46, 0x50, 0x56)
    assertThat(bytes.copyOfRange(4, 6)).containsExactly(0x01, 0x00)
    assertThat(bytes.copyOfRange(6, 8)).containsExactly(0x40, 0x00)
    assertThat(bytes.copyOfRange(8, 12)).containsExactly(0x00, 0x18, 0x15, 0x00)
    assertThat(bytes.copyOfRange(12, 16)).containsExactly(0x07, 0x00, 0x00, 0x00)
    assertThat(bytes.copyOfRange(16, 20)).containsExactly(0x02, 0x01, 0x00, 0x00)
    assertThat(bytes.copyOfRange(20, 22)).containsExactly(0x00, 0x05)
    assertThat(bytes.copyOfRange(22, 24)).isEqualTo(byteArrayOf(0xD0.toByte(), 0x02))
    assertThat(bytes[24]).isEqualTo(2.toByte())
    assertThat(bytes[25]).isEqualTo(1.toByte())
    assertThat(bytes[26]).isEqualTo(2.toByte())
    assertThat(bytes[27]).isEqualTo(2.toByte())
    assertThat(bytes.copyOfRange(28, 30)).containsExactly(0x01, 0x00)
    assertThat(bytes.copyOfRange(30, 32)).containsExactly(0x00, 0x00)
    assertThat(bytes.copyOfRange(32, 40))
      .containsExactly(0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01)
    assertThat(bytes.copyOfRange(40, 48))
      .containsExactly(0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11)
    assertThat(bytes.copyOfRange(48, 64)).isEqualTo(ByteArray(16))
  }

  @Test
  fun `packed size matches the documented 720p payload`() {
    assertThat(PreviewPixelFormat.I420.packedSize(1280, 720)).isEqualTo(1_382_400)
    assertThat(PreviewPixelFormat.NV12.packedSize(1280, 720)).isEqualTo(1_382_400)
    // Odd dimensions round chroma up; a reader that rounds down walks off the end.
    assertThat(PreviewPixelFormat.I420.packedSize(3, 3)).isEqualTo(9 + 2 * 4)
  }

  /**
   * `I420Packer.pack` calls `clear()` on its destination. Handing it the whole send buffer would
   * rewind past the header and the page would receive 64 bytes of luma where the magic belongs.
   * The production path slices past the header; this proves the slice actually protects it.
   */
  @Test
  fun `packing into a slice leaves the header intact`() {
    val width = 8
    val height = 4
    val payloadLength = PreviewPixelFormat.I420.packedSize(width, height)
    val bytes = ByteArray(PreviewFrameHeader.BYTE_COUNT + payloadLength)

    PreviewFrameHeader(
      payloadLength = payloadLength,
      sessionGeneration = 3,
      frameSequence = 9,
      width = width,
      height = height,
      pixelFormat = PreviewPixelFormat.I420,
    ).writeInto(bytes)

    val strideY = width + 5
    val chromaWidth = I420Packer.chromaStride(width)
    val chromaHeight = I420Packer.chromaStride(height)
    val strideChroma = chromaWidth + 3
    val y = ByteBuffer.allocateDirect(strideY * height)
    val u = ByteBuffer.allocateDirect(strideChroma * chromaHeight)
    val v = ByteBuffer.allocateDirect(strideChroma * chromaHeight)
    for (row in 0 until height) {
      for (column in 0 until width) y.put(row * strideY + column, (row * 10 + column).toByte())
    }
    for (row in 0 until chromaHeight) {
      for (column in 0 until chromaWidth) {
        u.put(row * strideChroma + column, (100 + column).toByte())
        v.put(row * strideChroma + column, (200 + column).toByte())
      }
    }

    val window = ByteBuffer.wrap(bytes)
    window.position(PreviewFrameHeader.BYTE_COUNT)
    val payload = window.slice()
    I420Packer.pack(y, strideY, u, strideChroma, v, strideChroma, width, height, payload)

    assertThat(bytes.copyOfRange(0, 4)).containsExactly(0x4D, 0x46, 0x50, 0x56)
    assertThat(ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).getInt(8)).isEqualTo(payloadLength)
    assertThat(bytes[PreviewFrameHeader.BYTE_COUNT]).isEqualTo(0.toByte())
    assertThat(bytes[PreviewFrameHeader.BYTE_COUNT + 1]).isEqualTo(1.toByte())
    // First chroma byte lands immediately after the luma plane, with no stride padding.
    assertThat(bytes[PreviewFrameHeader.BYTE_COUNT + width * height]).isEqualTo(100.toByte())
  }
}
