package com.mentra.framepreview

import com.mentra.glassesmedia.video.I420Packer
import java.nio.ByteBuffer
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class SyntheticI420PoolTest {
  private val width = 320
  private val height = 180

  @Test
  fun `leases are bounded so a slow worker skips instead of overwriting`() {
    val pool = SyntheticI420Pool(width, height, slots = 2)
    val first = pool.acquire(1, 0)!!
    val second = pool.acquire(2, 0)!!

    // Both leases are out. The generator must be refused rather than handed a buffer the
    // packing worker is still reading — that is the whole reason the pool is capped.
    assertThat(pool.acquire(3, 0)).isNull()

    first.release()
    assertThat(pool.acquire(4, 0)).isNotNull()
    second.release()
  }

  /**
   * The failure this guards against is silent: a generator that reuses a leased buffer produces
   * a frame whose header says "frame 7" and whose pixels are frame 9. The marker in the pattern
   * makes that visible, so a deliberately slow worker is asserted to still read frame 7.
   */
  @Test
  fun `a delayed worker still reads the frame it was given`() {
    val pool = SyntheticI420Pool(width, height, slots = 2)
    val held = pool.acquire(7, 0)!!

    // Meanwhile the generator keeps ticking, taking and returning the other lease.
    repeat(3) { index ->
      val other = pool.acquire(100 + index, 0)
      assertThat(other).isNotNull()
      other!!.release()
    }

    val packed = ByteArray(PreviewPixelFormat.I420.packedSize(width, height))
    I420Packer.pack(
      held.planes.y, held.planes.strideY,
      held.planes.u, held.planes.strideU,
      held.planes.v, held.planes.strideV,
      width, height,
      ByteBuffer.wrap(packed),
    )
    assertThat(PreviewTestPattern.readFrameMarker(packed, width)).isEqualTo(7)
    held.release()
  }

  @Test
  fun `synthetic planes are padded so the packer's stride path is exercised`() {
    val pool = SyntheticI420Pool(width, height, slots = 1)
    val lease = pool.acquire(1, 0)!!
    // A tight synthetic source would make the stride copy look free and the measurement would
    // not transfer to real decoder output.
    assertThat(lease.planes.isTight()).isFalse()
    assertThat(lease.planes.planesReadable()).isTrue()
    lease.release()
  }

  @Test
  fun `the pattern round trips through a tight pack`() {
    val pool = SyntheticI420Pool(width, height, slots = 1)
    // 320px carries 13 of the counter's 16 cells, so only indices that fit in 13 bits survive
    // a round trip at this size. The full range is covered below at a width that can hold it.
    for (index in listOf(0, 1, 42, 8_191)) {
      val lease = pool.acquire(index, 0)!!
      assertThat(PreviewTestPattern.readFrameMarker(packTightly(lease, width, height), width))
        .isEqualTo(index)
      lease.release()
    }
  }

  /**
   * The counter is 16 cells of 24px, so a frame narrower than 384px cannot carry all of it and
   * `readFrameMarker` returns only the bits that fit. The synthetic source runs at 1280×720
   * where the whole counter is present, which is the case that has to round trip exactly.
   */
  @Test
  fun `the full counter survives at the synthetic source's own width`() {
    val wide = 1280
    val tall = 720
    val pool = SyntheticI420Pool(wide, tall, slots = 1)
    for (index in listOf(0, 1, 42, 65_535)) {
      val lease = pool.acquire(index, 0)!!
      assertThat(PreviewTestPattern.readFrameMarker(packTightly(lease, wide, tall), wide))
        .isEqualTo(index)
      lease.release()
    }
  }

  private fun packTightly(lease: SyntheticI420Pool.Lease, width: Int, height: Int): ByteArray {
    val packed = ByteArray(PreviewPixelFormat.I420.packedSize(width, height))
    I420Packer.pack(
      lease.planes.y, lease.planes.strideY,
      lease.planes.u, lease.planes.strideU,
      lease.planes.v, lease.planes.strideV,
      width, height,
      ByteBuffer.wrap(packed),
    )
    return packed
  }
}
