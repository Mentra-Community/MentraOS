package com.mentra.acsmeeting.telemetry

import com.mentra.acsmeeting.video.I420Packer
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import java.nio.ByteBuffer

class ChromaProbeTest {
  @Test
  fun packedNeutralAveragesNearMidChroma() {
    val width = 8
    val height = 8
    val packed = ByteBuffer.allocate(I420Packer.packedSize(width, height))
    val ySize = width * height
    val uvSize = I420Packer.chromaStride(width) * I420Packer.chromaStride(height)
    repeat(ySize) { packed.put(100.toByte()) }
    repeat(uvSize) { packed.put(128.toByte()) }
    repeat(uvSize) { packed.put(128.toByte()) }
    packed.flip()
    val sample = ChromaProbe.samplePacked(packed, width, height)
    assertThat(sample.y).isEqualTo(100)
    assertThat(sample.u).isEqualTo(128)
    assertThat(sample.v).isEqualTo(128)
  }

  @Test
  fun samplePlanesAgreesWithSamplePacked() {
    val width = 8
    val height = 8
    val packed = ByteBuffer.allocate(I420Packer.packedSize(width, height))
    val ySize = width * height
    val uvSize = I420Packer.chromaStride(width) * I420Packer.chromaStride(height)
    repeat(ySize) { packed.put(90.toByte()) }
    repeat(uvSize) { packed.put(130.toByte()) }
    repeat(uvSize) { packed.put(126.toByte()) }
    packed.flip()
    val packedSample = ChromaProbe.samplePacked(packed, width, height)
    val y = packed.duplicate().apply { position(0); limit(ySize) }.slice()
    val u = packed.duplicate().apply { position(ySize); limit(ySize + uvSize) }.slice()
    val v = packed.duplicate().apply { position(ySize + uvSize); limit(ySize + 2 * uvSize) }.slice()
    val planeSample = ChromaProbe.samplePlanes(y, u, v)
    assertThat(planeSample).isEqualTo(packedSample)
  }

  @Test
  fun sampleNv12SeparatesInterleavedChroma() {
    val y = ByteBuffer.allocate(8)
    repeat(8) { y.put(100.toByte()) }
    y.flip()
    val uv = ByteBuffer.allocate(8)
    for (i in 0 until 4) {
      uv.put(130.toByte())
      uv.put(126.toByte())
    }
    uv.flip()
    val sample = ChromaProbe.sampleNv12(y, uv)
    assertThat(sample.y).isEqualTo(100)
    assertThat(sample.u).isEqualTo(130)
    assertThat(sample.v).isEqualTo(126)
  }
}
