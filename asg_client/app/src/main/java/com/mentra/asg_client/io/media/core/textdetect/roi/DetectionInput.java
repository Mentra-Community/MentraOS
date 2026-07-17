package com.mentra.asg_client.io.media.core.textdetect.roi;

import androidx.annotation.Nullable;
import java.util.Arrays;
import java.util.Objects;

/**
 * Immutable single-channel luminance image supplied to a text ROI detector, with an optional
 * reference to the original sensor JPEG bytes for detectors (such as ML Kit) that decode and
 * analyze the source image themselves instead of consuming pre-extracted luma.
 */
public final class DetectionInput {
    private final byte[] luma;
    private final int width;
    private final int height;
    @Nullable private final byte[] jpegBytes;

    /**
     * Creates an input image, defensively copying its luminance bytes.
     *
     * @param luma one byte per pixel in row-major order
     * @param width image width in pixels
     * @param height image height in pixels
     * @throws NullPointerException when {@code luma} is null
     * @throws IllegalArgumentException when dimensions are invalid or the buffer length differs
     */
    public DetectionInput(byte[] luma, int width, int height) {
        this(luma, width, height, null);
    }

    /**
     * Creates an input image that also carries the original sensor JPEG bytes, so a detector that
     * decodes color/full-resolution data itself (e.g. ML Kit) does not need a second JPEG read.
     *
     * @param luma one byte per pixel in row-major order
     * @param width image width in pixels
     * @param height image height in pixels
     * @param jpegBytes original sensor JPEG bytes, or {@code null} when unavailable
     * @throws NullPointerException when {@code luma} is null
     * @throws IllegalArgumentException when dimensions are invalid or the buffer length differs
     */
    public DetectionInput(byte[] luma, int width, int height, @Nullable byte[] jpegBytes) {
        Objects.requireNonNull(luma, "luma");
        if (width <= 0 || height <= 0) {
            throw new IllegalArgumentException("width and height must be positive");
        }
        long expectedLength = (long) width * height;
        if (expectedLength > Integer.MAX_VALUE || luma.length != (int) expectedLength) {
            throw new IllegalArgumentException(
                    "luma length must equal width * height: expected "
                            + expectedLength
                            + ", got "
                            + luma.length);
        }
        this.luma = Arrays.copyOf(luma, luma.length);
        this.width = width;
        this.height = height;
        this.jpegBytes = jpegBytes == null ? null : Arrays.copyOf(jpegBytes, jpegBytes.length);
    }

    /** Returns a defensive copy of the row-major luminance bytes. */
    public byte[] luma() {
        return Arrays.copyOf(luma, luma.length);
    }

    /** Returns the image width in pixels. */
    public int width() {
        return width;
    }

    /** Returns the image height in pixels. */
    public int height() {
        return height;
    }

    /**
     * Returns a defensive copy of the original sensor JPEG bytes, or {@code null} when this input
     * was constructed without them.
     */
    @Nullable
    public byte[] jpegBytes() {
        return jpegBytes == null ? null : Arrays.copyOf(jpegBytes, jpegBytes.length);
    }

    byte[] lumaUnsafe() {
        return luma;
    }

    @Nullable
    byte[] jpegBytesUnsafe() {
        return jpegBytes;
    }
}
