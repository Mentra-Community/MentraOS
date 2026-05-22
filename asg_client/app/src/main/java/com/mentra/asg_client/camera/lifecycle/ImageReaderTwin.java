package com.mentra.asg_client.camera.lifecycle;

import android.graphics.ImageFormat;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.util.Size;
import android.view.Surface;

import java.util.ArrayList;
import java.util.List;

/**
 * Pairs a low-resolution YUV preview {@link ImageReader} with a full-resolution JPEG still reader so
 * repeating preview does not share the still capture buffer queue.
 */
public final class ImageReaderTwin {
    public static final int PREVIEW_WIDTH = 320;
    public static final int PREVIEW_HEIGHT = 240;
    public static final int BUFFER_COUNT = 2;

    private final ImageReader previewReader;
    private final ImageReader stillReader;

    public ImageReaderTwin(
            Size jpegSize,
            Handler backgroundHandler,
            ImageReader.OnImageAvailableListener stillListener) {
        previewReader = ImageReader.newInstance(
                PREVIEW_WIDTH, PREVIEW_HEIGHT, ImageFormat.YUV_420_888, BUFFER_COUNT);
        stillReader = ImageReader.newInstance(
                jpegSize.getWidth(), jpegSize.getHeight(), ImageFormat.JPEG, BUFFER_COUNT);
        previewReader.setOnImageAvailableListener(
                reader -> {
                    try (Image image = reader.acquireLatestImage()) {
                        // discard — keeps preview buffers from stalling
                    } catch (IllegalStateException ignored) {
                        // Expected when the reader is closed mid-callback; swallow so we don't
                        // mask genuinely fatal errors with a blanket Throwable.
                    }
                },
                backgroundHandler);
        stillReader.setOnImageAvailableListener(stillListener, backgroundHandler);
    }

    public Surface getPreviewSurface() {
        return previewReader.getSurface();
    }

    public Surface getStillSurface() {
        return stillReader.getSurface();
    }

    public List<Surface> surfaces() {
        List<Surface> list = new ArrayList<>(2);
        list.add(getPreviewSurface());
        list.add(getStillSurface());
        return list;
    }

    public void close() {
        previewReader.close();
        stillReader.close();
    }

    /** Visible for unit tests. */
    ImageReader previewReaderForTesting() {
        return previewReader;
    }

    /** Visible for unit tests. */
    ImageReader stillReaderForTesting() {
        return stillReader;
    }
}
