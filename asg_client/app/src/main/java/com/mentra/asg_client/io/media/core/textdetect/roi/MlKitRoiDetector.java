package com.mentra.asg_client.io.media.core.textdetect.roi;

import androidx.annotation.Nullable;
import com.mentra.asg_client.io.media.core.textdetect.CropRect;
import com.mentra.asg_client.io.media.core.textdetect.DetectionResult;
import com.mentra.asg_client.io.media.core.textdetect.MlKitTextRoiDetector;

/**
 * Adapter that exposes the bundled ML Kit text localizer through the swappable {@link
 * TextRoiDetector} contract.
 *
 * <p>Unlike the classical and ONNX detectors, ML Kit decodes and analyzes the original sensor JPEG
 * bytes directly rather than pre-extracted luma, so this adapter requires {@link
 * DetectionInput#jpegBytes()} to be present. When bytes are unavailable, or when ML Kit finds no
 * text, this adapter's fallback is the full frame (matching ML Kit's own "preserve the full frame
 * on uncertainty" policy) rather than the classical/ONNX detectors' 75% center-crop fallback.
 */
public final class MlKitRoiDetector implements TextRoiDetector {
    private final MlKitTextRoiDetector delegate;
    private volatile boolean closed;

    /** Creates an adapter that owns one persistent ML Kit recognizer client. */
    public MlKitRoiDetector() {
        this.delegate = new MlKitTextRoiDetector();
    }

    /** Starts ML Kit model initialization ahead of the first real detection. Safe to repeat. */
    @Override
    public void warmUp() {
        delegate.warmUp();
    }

    /** Detects a padded source-pixel ROI from the input's sensor JPEG bytes. */
    @Override
    public DetectionResult detect(DetectionInput input) {
        long start = System.currentTimeMillis();
        byte[] jpegBytes = input.jpegBytesUnsafe();
        if (jpegBytes == null || jpegBytes.length == 0) {
            return fullFrame(
                    input.width(),
                    input.height(),
                    System.currentTimeMillis() - start,
                    "missing_jpeg_bytes");
        }
        MlKitTextRoiDetector.Detection detection = delegate.detect(jpegBytes);
        if (detection.roi == null) {
            // detection.sourceWidth/Height come from decoding jpegBytes itself, so they are the
            // authoritative source-pixel size here - not input.width()/height(), which is the
            // separate subsampled analysis-luma buffer's own dimensions.
            return fullFrame(
                    detection.sourceWidth > 0 ? detection.sourceWidth : input.width(),
                    detection.sourceHeight > 0 ? detection.sourceHeight : input.height(),
                    detection.elapsedMs,
                    detection.reason);
        }
        CropRect roi =
                CropRect.clamp(
                        new CropRect(
                                detection.roi.left,
                                detection.roi.top,
                                detection.roi.right,
                                detection.roi.bottom),
                        detection.sourceWidth,
                        detection.sourceHeight);
        return new DetectionResult(
                roi,
                DetectionResult.Confidence.MEDIUM,
                id(),
                detection.lineCount,
                detection.lineCount > 0 ? 1 : 0,
                detection.elapsedMs,
                null,
                null);
    }

    /** Returns {@code ml_kit}. */
    @Override
    public String id() {
        return TextCropModel.ML_KIT.id();
    }

    /** ML Kit decodes and analyzes the sensor JPEG itself, so its crop is already source-pixel. */
    @Override
    public boolean returnsNativeCoordinates() {
        return true;
    }

    /** Returns false after this detector has been closed. */
    @Override
    public boolean isReady() {
        return !closed;
    }

    /** Closes the owned ML Kit recognizer client. */
    @Override
    public void close() {
        closed = true;
        delegate.close();
    }

    private DetectionResult fullFrame(
            int width, int height, long elapsedMs, @Nullable String reason) {
        return new DetectionResult(
                new CropRect(0, 0, width, height),
                DetectionResult.Confidence.NONE,
                id(),
                0,
                0,
                elapsedMs,
                reason,
                null);
    }
}
