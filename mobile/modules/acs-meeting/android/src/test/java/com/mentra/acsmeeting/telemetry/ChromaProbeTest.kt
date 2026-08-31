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
}
