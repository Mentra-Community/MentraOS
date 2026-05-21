package com.mentra.asg_client.camera.lifecycle;

import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CaptureFailure;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.os.Handler;
import android.util.Log;
import android.util.Range;
import android.view.Surface;

import androidx.annotation.NonNull;

import com.mentra.asg_client.camera.CameraSettings;
import com.mentra.asg_client.camera.request.HdrBurstBuilder;
import com.mentra.asg_client.camera.request.StillCaptureBuilder;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Owns active HDR burst capture state, request building, and frame routing. */
public final class HdrBurstCapture {

    public interface FrameSaver {
        boolean save(byte[] data, String filePath);
    }

    public interface Callback {
        void onBurstComplete(String basePath);
        void onBurstFailed(String reason);
        void onAllCaptureRequestsCompleted(CameraCaptureSession session);
    }

    private static final String TAG = "HdrBurstCapture";

    private volatile int framesReceived;
    private volatile boolean active;

    public boolean isActive() {
        return active;
    }

    public int framesReceived() {
        return framesReceived;
    }

    public void start(CameraCaptureSession session,
                      CameraDevice device,
                      Surface stillSurface,
                      Handler backgroundHandler,
                      Range<Integer> selectedFpsRange,
                      boolean hasAutoFocus,
                      int jpegQuality,
                      int jpegOrientation,
                      CameraSettings cameraSettings,
                      Callback callback) throws CameraAccessException {
        active = true;
        framesReceived = 0;

        Log.i(TAG, "HDR: Starting burst capture with brackets "
                + Arrays.toString(HdrBurstBuilder.HDR_EV_BRACKETS));

        List<CaptureRequest> burstRequests = new ArrayList<>();
        for (int ev : HdrBurstBuilder.HDR_EV_BRACKETS) {
            CaptureRequest.Builder builder =
                    device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            builder.addTarget(stillSurface);

            HdrBurstBuilder.configureBracket(StillCaptureBuilder.wrap(builder), ev,
                    selectedFpsRange, hasAutoFocus, jpegQuality, jpegOrientation);

            if (cameraSettings != null
                    && (cameraSettings.mAsgSettings.isZslEnabled()
                    || cameraSettings.mAsgSettings.isMfnrEnabled())) {
                cameraSettings.configureCaptureBuilder(builder);
            }

            burstRequests.add(builder.build());
        }

        session.captureBurst(burstRequests, new CameraCaptureSession.CaptureCallback() {
            private int completedCount = 0;

            @Override
            public void onCaptureCompleted(@NonNull CameraCaptureSession completedSession,
                                           @NonNull CaptureRequest request,
                                           @NonNull TotalCaptureResult result) {
                completedCount++;
                Integer ev = request.get(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION);
                Integer iso = result.get(CaptureResult.SENSOR_SENSITIVITY);
                Long expNs = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
                Log.i(TAG, "HDR: Frame " + completedCount + "/" + HdrBurstBuilder.HDR_BURST_COUNT
                        + " completed (EV=" + ev + " ISO=" + iso
                        + " exp=" + (expNs != null ? expNs / 1_000_000.0 : "?") + "ms)");

                if (completedCount == HdrBurstBuilder.HDR_BURST_COUNT) {
                    Log.i(TAG, "HDR: All burst frames captured");
                    callback.onAllCaptureRequestsCompleted(completedSession);
                }
            }

            @Override
            public void onCaptureFailed(@NonNull CameraCaptureSession failedSession,
                                        @NonNull CaptureRequest request,
                                        @NonNull CaptureFailure failure) {
                Log.e(TAG, "HDR: Burst frame failed: " + failure.getReason());
                active = false;
                callback.onBurstFailed("HDR burst capture failed");
                callback.onAllCaptureRequestsCompleted(failedSession);
            }
        }, backgroundHandler);
    }

    /**
     * Route one still-reader JPEG into the bracket files. Returns true when the frame was consumed
     * by the active burst path and normal photo save handling should be skipped.
     */
    public boolean handleFrame(byte[] bytes, String targetPath, FrameSaver saver, Callback callback) {
        if (!active) {
            return false;
        }

        int frameIdx = framesReceived;
        framesReceived++;
        File parentDir = new File(targetPath).getParentFile();
        String bracketPath = new File(parentDir,
                HdrBurstBuilder.bracketFileSuffix(frameIdx) + ".jpg").getAbsolutePath();
        boolean saved = saver.save(bytes, bracketPath);
        Log.d(TAG, "HDR: Saved bracket " + (frameIdx + 1) + "/" + HdrBurstBuilder.HDR_BURST_COUNT
                + " -> " + bracketPath + " (success=" + saved + ")");

        if (framesReceived >= HdrBurstBuilder.HDR_BURST_COUNT) {
            active = false;
            copyEv0AsBase(targetPath);
            Log.i(TAG, "HDR: Burst complete, base saved: " + targetPath);
            callback.onBurstComplete(targetPath);
        }
        return true;
    }

    public void cancel() {
        active = false;
        framesReceived = 0;
    }

    private static void copyEv0AsBase(String targetPath) {
        File parentDir = new File(targetPath).getParentFile();
        String ev0Path = new File(parentDir, "ev0.jpg").getAbsolutePath();
        try {
            Files.copy(new File(ev0Path).toPath(), new File(targetPath).toPath(),
                    StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception copyErr) {
            Log.w(TAG, "HDR: Could not copy EV0 as base file", copyErr);
        }
    }
}
