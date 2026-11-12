package com.mentra.framepreview

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class FramePreviewPortTest {
  @Test
  fun `a WebView that never loaded or still has its source held needs no reload`() {
    assertThat(FramePreviewPort.needsInstallReload(null)).isFalse()
    assertThat(FramePreviewPort.needsInstallReload("about:blank")).isFalse()
  }

  @Test
  fun `a page that loaded before the listener needs one reload to get the port`() {
    assertThat(FramePreviewPort.needsInstallReload("https://com.mentra.call.miniapp.invalid/ui/index.html")).isTrue()
    assertThat(FramePreviewPort.needsInstallReload("http://192.168.1.20:8081/dist/ui/index.html")).isTrue()
  }
}
