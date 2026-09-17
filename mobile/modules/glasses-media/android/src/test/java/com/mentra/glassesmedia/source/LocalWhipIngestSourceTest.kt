package com.mentra.glassesmedia.source

import android.content.Context
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import org.mockito.Mockito.mock

class LocalWhipIngestSourceTest {
  @Test
  fun `frames resume on the same peer after a stall without an ICE transition`() {
    val source = source()
    val states = mutableListOf<SourceState>()
    source.setStateListener { state, _ -> states.add(state) }
    arm(source)
    frame(source)
    assertThat(source.state).isEqualTo(SourceState.LIVE)

    repeat(2) {
      repeat(3) { sample(source) }
      assertThat(source.state).isEqualTo(SourceState.FAILED)
      frame(source)
      assertThat(source.state).isEqualTo(SourceState.LIVE)
      frame(source)
    }
    assertThat(states).containsExactly(
      SourceState.LIVE, SourceState.FAILED, SourceState.LIVE,
      SourceState.FAILED, SourceState.LIVE,
    )
  }

  @Test
  fun `stale peer samples cannot fail or rearm the current peer`() {
    val source = source()
    arm(source)
    frame(source)
    repeat(3) { sample(source, generation = -1) }
    assertThat(source.state).isEqualTo(SourceState.LIVE)
    repeat(2) { sample(source) }
    assertThat(source.state).isEqualTo(SourceState.LIVE)
    sample(source)
    assertThat(source.state).isEqualTo(SourceState.FAILED)
  }

  @Test
  fun `a frame after stop cannot revive the source`() {
    val source = source()
    arm(source)
    frame(source)
    repeat(3) { sample(source) }
    source.stop()
    frame(source)
    assertThat(source.state).isEqualTo(SourceState.IDLE)
  }

  private fun source() = LocalWhipIngestSource(mock(Context::class.java), {}, { _, _, _ -> })

  // Drive the production callbacks without starting libwebrtc or binding a network socket.
  private fun arm(source: LocalWhipIngestSource) {
    LocalWhipIngestSource::class.java.getDeclaredMethod("armFirstFrame", Int::class.javaPrimitiveType)
      .apply { isAccessible = true }.invoke(source, 0)
  }

  private fun frame(source: LocalWhipIngestSource) {
    LocalWhipIngestSource::class.java.getDeclaredMethod("notePromotableFrame")
      .apply { isAccessible = true }.invoke(source)
  }

  private fun sample(source: LocalWhipIngestSource, generation: Int = 0) {
    LocalWhipIngestSource::class.java.getDeclaredMethod(
      "noteIngestStall", Int::class.javaPrimitiveType, String::class.java,
      Double::class.javaPrimitiveType, Long::class.javaPrimitiveType,
    ).apply { isAccessible = true }.invoke(source, generation, "completed", 0.0, 100L)
  }
}
