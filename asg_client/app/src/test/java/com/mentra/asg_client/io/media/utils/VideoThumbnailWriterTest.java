package com.mentra.asg_client.io.media.utils;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class VideoThumbnailWriterTest {

    @Rule public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void sidecarFor_isThumbJpgInCaptureFolder() throws IOException {
        File captureDir = temporaryFolder.newFolder("VID_20260731_120000_123_456");
        File video = new File(captureDir, "base.mp4");

        File sidecar = VideoThumbnailWriter.sidecarFor(video);

        assertThat(sidecar.getParentFile()).isEqualTo(captureDir);
        assertThat(sidecar.getName()).isEqualTo("thumb.jpg");
    }

    @Test
    public void writeSidecar_missingVideo_returnsNullAndWritesNothing() throws IOException {
        File captureDir = temporaryFolder.newFolder("VID_20260731_120000_123_456");
        File video = new File(captureDir, "base.mp4");

        File result = VideoThumbnailWriter.writeSidecar(video);

        assertThat(result).isNull();
        assertThat(captureDir.listFiles()).isEmpty();
    }

    @Test
    public void writeSidecar_undecodableVideo_returnsNullAndLeavesNoTempFile() throws IOException {
        // Robolectric's MediaMetadataRetriever shadow returns no frames, which also models a
        // corrupt/undecodable mp4: generation must fail cleanly with no thumb.jpg and no .tmp.
        File captureDir = temporaryFolder.newFolder("VID_20260731_120000_123_456");
        File video = new File(captureDir, "base.mp4");
        try (FileOutputStream fos = new FileOutputStream(video)) {
            fos.write(new byte[] {0, 1, 2, 3});
        }

        File result = VideoThumbnailWriter.writeSidecar(video);

        assertThat(result).isNull();
        assertThat(captureDir.listFiles()).containsExactly(video);
    }

    @Test
    public void writeSidecar_nullVideo_returnsNull() {
        assertThat(VideoThumbnailWriter.writeSidecar(null)).isNull();
    }
}
