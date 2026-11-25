package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class PhotoThumbnailTest {
    @Test
    fun `the long side is scaled to 512 px and the aspect kept`() {
        assertThat(PhotoThumbnails.targetSize(3264, 2448)).isEqualTo(512 to 384)
        assertThat(PhotoThumbnails.targetSize(2448, 3264)).isEqualTo(384 to 512)
        assertThat(PhotoThumbnails.targetSize(4000, 1000)).isEqualTo(512 to 128)
    }

    @Test
    fun `a small photo is never upscaled`() {
        assertThat(PhotoThumbnails.targetSize(500, 375)).isEqualTo(500 to 375)
    }

    @Test
    fun `the thumbnail sits beside the photo`() {
        assertThat(PhotoThumbnails.fileFor("/cache/photos/p1.jpg").path).isEqualTo("/cache/photos/p1.thumb.jpg")
        assertThat(PhotoThumbnails.fileFor("/cache/glasses-file-p1").path).isEqualTo("/cache/glasses-file-p1.thumb.jpg")
    }

    @Test
    fun `a missing photo has no thumbnail`() {
        assertThat(PhotoThumbnails.make("file:///nowhere/p1.jpg")).isNull()
    }
}
