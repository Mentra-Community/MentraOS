package com.mentra.asg_client.io.media.utils;

import static org.assertj.core.api.Assertions.assertThat;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import com.mentra.asg_client.AsgConstants;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

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
        // corrupt/undecodable mp4: generation must fail cleanly with no sidecar or .partial file.
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

    @Test
    public void writeSidecar_validFrame_scalesCompressesAndCommitsAtomically() throws IOException {
        File captureDir = temporaryFolder.newFolder("VID_success");
        File video = write(new File(captureDir, "base.mp4"));
        Bitmap source = Bitmap.createBitmap(960, 480, Bitmap.Config.ARGB_8888);
        source.eraseColor(Color.BLUE);
        AtomicReference<Bitmap.CompressFormat> format = new AtomicReference<>();
        AtomicInteger quality = new AtomicInteger();

        File result =
                VideoThumbnailWriter.writeSidecar(
                        video,
                        ignored -> source,
                        File::renameTo,
                        (bitmap, requestedFormat, requestedQuality, output) -> {
                            format.set(requestedFormat);
                            quality.set(requestedQuality);
                            return bitmap.compress(requestedFormat, requestedQuality, output);
                        });

        assertThat(result).isEqualTo(VideoThumbnailWriter.sidecarFor(video)).exists();
        assertThat(new File(captureDir, AsgConstants.VIDEO_THUMBNAIL_PARTIAL_NAME)).doesNotExist();
        assertThat(format.get()).isEqualTo(Bitmap.CompressFormat.JPEG);
        assertThat(quality.get()).isEqualTo(AsgConstants.VIDEO_THUMBNAIL_JPEG_QUALITY);
        Bitmap decoded = BitmapFactory.decodeFile(result.getAbsolutePath());
        assertThat(decoded.getWidth()).isEqualTo(AsgConstants.VIDEO_THUMBNAIL_MAX_DIMENSION);
        assertThat(decoded.getHeight()).isEqualTo(240);
        decoded.recycle();
        assertThat(source.isRecycled()).isTrue();
    }

    @Test
    public void writeSidecar_compressionFailure_removesPartialAndDoesNotCommit()
            throws IOException {
        File captureDir = temporaryFolder.newFolder("VID_compress_failure");
        File video = write(new File(captureDir, "base.mp4"));
        Bitmap source = Bitmap.createBitmap(100, 50, Bitmap.Config.ARGB_8888);
        AtomicBoolean commitCalled = new AtomicBoolean(false);

        File result =
                VideoThumbnailWriter.writeSidecar(
                        video,
                        ignored -> source,
                        (partial, sidecar) -> {
                            commitCalled.set(true);
                            return partial.renameTo(sidecar);
                        },
                        (bitmap, format, quality, output) -> false);

        assertThat(result).isNull();
        assertThat(commitCalled).isFalse();
        assertThat(captureDir.listFiles()).containsExactly(video);
        assertThat(source.isRecycled()).isTrue();
    }

    @Test
    public void writeSidecar_commitFailure_removesPartialAndReturnsNull() throws IOException {
        File captureDir = temporaryFolder.newFolder("VID_commit_failure");
        File video = write(new File(captureDir, "base.mp4"));
        Bitmap source = Bitmap.createBitmap(100, 50, Bitmap.Config.ARGB_8888);

        File result =
                VideoThumbnailWriter.writeSidecar(
                        video,
                        ignored -> source,
                        (partial, sidecar) -> false,
                        (bitmap, format, quality, output) ->
                                bitmap.compress(format, quality, output));

        assertThat(result).isNull();
        assertThat(captureDir.listFiles()).containsExactly(video);
        assertThat(source.isRecycled()).isTrue();
    }

    @Test
    public void deleteSidecar_removesFinalAndPartialArtifactsButKeepsVideo() throws IOException {
        File captureDir = temporaryFolder.newFolder("VID_20260731_120000_123_456");
        File video = write(new File(captureDir, "base.mp4"));
        File sidecar = write(new File(captureDir, AsgConstants.VIDEO_THUMBNAIL_SIDECAR_NAME));
        File partial = write(new File(captureDir, AsgConstants.VIDEO_THUMBNAIL_PARTIAL_NAME));

        VideoThumbnailWriter.deleteSidecar(video);

        assertThat(video).exists();
        assertThat(sidecar).doesNotExist();
        assertThat(partial).doesNotExist();
    }

    @Test
    public void extractFrameWithTimeout_stalledDecoderReturnsPromptly() throws IOException {
        File video = new File(temporaryFolder.newFolder("VID_timeout"), "base.mp4");
        AtomicBoolean cancelCalled = new AtomicBoolean(false);
        long startedAt = System.nanoTime();

        assertThat(
                        VideoThumbnailWriter.extractFrameWithTimeout(
                                video,
                                new VideoThumbnailWriter.FrameExtractor() {
                                    @Override
                                    public Bitmap extract(File ignored) {
                                        try {
                                            Thread.sleep(5_000);
                                        } catch (InterruptedException e) {
                                            Thread.currentThread().interrupt();
                                        }
                                        return null;
                                    }

                                    @Override
                                    public void cancel() {
                                        cancelCalled.set(true);
                                    }
                                },
                                10))
                .isNull();

        long elapsedMs = (System.nanoTime() - startedAt) / 1_000_000L;
        assertThat(elapsedMs).isLessThan(1_000L);
        assertThat(cancelCalled).isTrue();
    }

    private static File write(File file) throws IOException {
        try (FileOutputStream fos = new FileOutputStream(file)) {
            fos.write(new byte[] {0, 1, 2, 3});
        }
        return file;
    }
}
