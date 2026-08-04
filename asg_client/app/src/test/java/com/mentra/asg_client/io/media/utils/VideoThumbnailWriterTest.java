package com.mentra.asg_client.io.media.utils;

import static org.assertj.core.api.Assertions.assertThat;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import com.mentra.asg_client.AsgConstants;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.After;
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

    @After
    public void releaseDecoderWorker() {
        VideoThumbnailWriter.shutdownFrameExtraction();
    }

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
    public void scaledTargetSize_largeFrameBoundsLongestEdgeAndPreservesAspectRatio() {
        assertThat(VideoThumbnailWriter.scaledTargetSize(3840, 2160))
                .containsExactly(AsgConstants.VIDEO_THUMBNAIL_MAX_DIMENSION, 270);
    }

    @Test
    public void scaledTargetSize_smallFrameKeepsOriginalDimensions() {
        assertThat(VideoThumbnailWriter.scaledTargetSize(320, 240)).containsExactly(320, 240);
    }

    @Test
    public void scaledTargetSize_invalidDimensionsUsesBoundedFallback() {
        assertThat(VideoThumbnailWriter.scaledTargetSize(0, 240))
                .containsExactly(
                        AsgConstants.VIDEO_THUMBNAIL_MAX_DIMENSION,
                        AsgConstants.VIDEO_THUMBNAIL_MAX_DIMENSION);
        assertThat(VideoThumbnailWriter.scaledTargetSize(320, -1))
                .containsExactly(
                        AsgConstants.VIDEO_THUMBNAIL_MAX_DIMENSION,
                        AsgConstants.VIDEO_THUMBNAIL_MAX_DIMENSION);
    }

    @Test
    public void orientedDimensions_quarterTurnsSwapCodedDimensions() {
        assertThat(VideoThumbnailWriter.orientedDimensions(1920, 1080, 90))
                .containsExactly(1080, 1920);
        assertThat(VideoThumbnailWriter.orientedDimensions(1920, 1080, 270))
                .containsExactly(1080, 1920);
        assertThat(VideoThumbnailWriter.orientedDimensions(1920, 1080, -90))
                .containsExactly(1080, 1920);
    }

    @Test
    public void orientedDimensions_halfTurnsKeepCodedDimensions() {
        assertThat(VideoThumbnailWriter.orientedDimensions(1920, 1080, 0))
                .containsExactly(1920, 1080);
        assertThat(VideoThumbnailWriter.orientedDimensions(1920, 1080, 180))
                .containsExactly(1920, 1080);
    }

    @Test
    public void frameWithFallback_preferredSeekThrows_triesFirstFrame() {
        AtomicInteger calls = new AtomicInteger();
        Bitmap firstFrame = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888);

        Bitmap extracted =
                VideoThumbnailWriter.frameWithFallback(
                        timeUs -> {
                            calls.incrementAndGet();
                            if (timeUs == AsgConstants.VIDEO_THUMBNAIL_FRAME_TIME_US) {
                                throw new IllegalArgumentException("preferred seek unavailable");
                            }
                            assertThat(timeUs).isZero();
                            return firstFrame;
                        });

        assertThat(extracted).isSameAs(firstFrame);
        assertThat(calls).hasValue(2);
        extracted.recycle();
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

    @Test
    public void extractFrameWithTimeout_hungDecoderDoesNotBlockNextVideo() throws Exception {
        File hungVideo = new File(temporaryFolder.newFolder("VID_hung"), "base.mp4");
        File nextVideo = new File(temporaryFolder.newFolder("VID_next"), "base.mp4");
        CountDownLatch decoderStarted = new CountDownLatch(1);
        CountDownLatch releaseDecoder = new CountDownLatch(1);
        AtomicReference<Bitmap> firstResult = new AtomicReference<>();
        Thread timeoutCaller =
                new Thread(
                        () ->
                                firstResult.set(
                                        VideoThumbnailWriter.extractFrameWithTimeout(
                                                hungVideo,
                                                ignored -> {
                                                    decoderStarted.countDown();
                                                    while (releaseDecoder.getCount() > 0) {
                                                        try {
                                                            releaseDecoder.await();
                                                        } catch (InterruptedException ignored2) {
                                                            // Model a native decode that ignores
                                                            // interruption.
                                                        }
                                                    }
                                                    return null;
                                                },
                                                50)),
                        "ThumbnailTimeoutTest");

        try {
            timeoutCaller.start();
            assertThat(decoderStarted.await(1, TimeUnit.SECONDS)).isTrue();
            timeoutCaller.join(1_000);
            assertThat(timeoutCaller.isAlive()).isFalse();
            assertThat(firstResult.get()).isNull();

            Bitmap nextFrame = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888);
            Bitmap extracted =
                    VideoThumbnailWriter.extractFrameWithTimeout(
                            nextVideo, ignored -> nextFrame, 1_000);

            assertThat(extracted).isSameAs(nextFrame);
            extracted.recycle();
        } finally {
            releaseDecoder.countDown();
            timeoutCaller.join(1_000);
        }
    }

    @Test
    public void shutdownFrameExtraction_nextUseRestartsDecoderLazily() throws IOException {
        File video = new File(temporaryFolder.newFolder("VID_restart"), "base.mp4");
        VideoThumbnailWriter.shutdownFrameExtraction();
        Bitmap frame = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888);

        Bitmap extracted =
                VideoThumbnailWriter.extractFrameWithTimeout(video, ignored -> frame, 1_000);

        assertThat(extracted).isSameAs(frame);
        extracted.recycle();
    }

    private static File write(File file) throws IOException {
        try (FileOutputStream fos = new FileOutputStream(file)) {
            fos.write(new byte[] {0, 1, 2, 3});
        }
        return file;
    }
}
